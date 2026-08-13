import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, stockMovements, wasteEntries } from "@/db/schema";
import { toBaseQuantity } from "@/lib/units";
import { wasteInput } from "@/lib/validation";
import { ActionError } from "@/lib/action-error";
import { isDemoMode } from "@/lib/demo-mode";
import { toActionError } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { getOrganizationUnits, getTenantContext, hasPermission } from "@/server/tenant";

/**
 * Waste recording over HTTP, used by the offline queue as well as the form.
 *
 * Unlike `/api/purchases`, which delegates to a guarded server action, this
 * handler writes directly — so it has to perform the same authorization the
 * action layer would. Membership alone is not enough: recording waste moves
 * stock and destroys value, which is a `record_operations` write. Without this
 * check an accountant could post stock movements by calling the endpoint even
 * though every button that reaches it is hidden from them.
 *
 * The location is taken from the session, never from the body. `wasteInput`
 * carries a `locationId` because the form round-trips one for display, but what
 * is written is `tenant.locationId` — so editing the payload cannot post
 * spoilage against another branch.
 */
export async function POST(request: Request) {
  try {
    const input = wasteInput.parse(await request.json());
    const tenant = await getTenantContext();
    if (!tenant || "needsOnboarding" in tenant || !tenant.locationId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!hasPermission(tenant.role, "record_operations")) {
      return NextResponse.json({ error: "Your role does not allow recording waste." }, { status: 403 });
    }
    if (isDemoMode()) return NextResponse.json({ ok: true, demo: true });

    const db = getDb();
    // Loaded outside the transaction: the conversion table is per-organization
    // reference data, and holding a transaction open to read it buys nothing.
    const units = await getOrganizationUnits(tenant.organizationId);

    const result = await db.transaction(async tx => {
      const [ingredient] = await tx
        .select()
        .from(ingredients)
        .where(and(eq(ingredients.id, input.ingredientId), eq(ingredients.organizationId, tenant.organizationId)))
        .limit(1);
      // Scoped in the WHERE clause rather than compared afterwards, so the query
      // cannot confirm that another workspace's ingredient exists.
      if (!ingredient) throw new ActionError("Ingredient not found.");

      /**
       * The form offers every unit compatible with the ingredient (grams for
       * something stocked in kilograms), so the typed quantity has to be
       * converted before it reaches the ledger — which holds base units only.
       *
       * Writing `input.quantity` straight through, as this handler used to,
       * deducted 2 g for "2 kg wasted" and priced the loss at two grams' worth.
       * Purchases, transfers and counts all convert through this same helper;
       * waste was the one path that did not.
       */
      const baseQuantity = toBaseQuantity(input.quantity, input.unitCode ?? ingredient.baseUnitCode, ingredient.baseUnitCode, units);
      // Cost follows the converted quantity: `latest_unit_cost_millis` is the
      // price of one *base* unit, so it may only ever multiply a base quantity.
      const estimatedCostMillis = Math.round(baseQuantity * ingredient.latestUnitCostMillis);

      const [waste] = await tx
        .insert(wasteEntries)
        .values({
          organizationId: tenant.organizationId,
          locationId: tenant.locationId!,
          ingredientId: input.ingredientId,
          quantity: String(baseQuantity),
          estimatedCostMillis,
          reason: input.reason,
          note: input.note,
          createdBy: tenant.userId,
          clientOperationId: input.clientOperationId,
        })
        .returning();

      await tx.insert(stockMovements).values({
        organizationId: tenant.organizationId,
        locationId: tenant.locationId!,
        ingredientId: input.ingredientId,
        type: "waste",
        quantity: String(-baseQuantity),
        unitCostMillis: ingredient.latestUnitCostMillis,
        referenceType: "waste_entry",
        referenceId: waste.id,
        performedBy: tenant.userId,
        clientOperationId: input.clientOperationId,
      });

      // Inside the transaction: waste destroys stock and value, so the record of
      // who did it must not be able to go missing while the write succeeds.
      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "waste_recorded",
          entityType: "waste_entry",
          entityId: waste.id,
          metadata: {
            ingredientId: input.ingredientId,
            ingredientName: ingredient.name,
            locationId: tenant.locationId,
            quantity: baseQuantity,
            enteredQuantity: input.quantity,
            enteredUnit: input.unitCode ?? ingredient.baseUnitCode,
            unit: ingredient.baseUnitCode,
            reason: input.reason,
            estimatedCostMillis,
          },
        },
        tx,
      );

      return waste;
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    // Routed through the same translator the server actions use, so a driver
    // error cannot reach the client as prose: recognized failures get a written
    // message, everything else gets a generic sentence and a log reference.
    const duplicate = (error as { code?: string } | null)?.code === "23505";
    const failure = toActionError(error);
    return NextResponse.json(
      { error: duplicate ? "Already synchronized" : failure.error, fieldErrors: failure.fieldErrors },
      { status: duplicate ? 409 : 400 },
    );
  }
}
