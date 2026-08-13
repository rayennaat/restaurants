"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, purchaseItems, purchases, stockMovements, supplierProducts, suppliers } from "@/db/schema";
import { toMinorUnits, minorUnitScale } from "@/lib/money";
import { toBaseQuantity, toBaseUnitCost } from "@/lib/units";
import { purchaseInput } from "@/lib/validation";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { assertMemberLocation } from "@/server/queries/locations";
import { getOrganizationUnits, requirePermission, requireTenantLocation } from "@/server/tenant";

function revalidatePurchaseViews(purchaseId?: string) {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/purchases");
  if (purchaseId) revalidatePath(`/dashboard/purchases/${purchaseId}`);
  revalidatePath("/dashboard/inventory");
  revalidatePath("/dashboard/ingredients");
  revalidatePath("/dashboard/suppliers");
  revalidatePath("/dashboard/recipes");
  revalidatePath("/dashboard/menu");
}

/**
 * Receives a multi-line supplier invoice.
 *
 * One transaction does all of:
 *  1. Inserts the purchase + items (storing both the invoice-unit quantities
 *     and their base-unit equivalents).
 *  2. Pushes one `stock_movement` per line so inventory balances update.
 *  3. Updates `ingredients.latest_unit_cost_millis` with the most recent
 *     per-base-unit price paid.
 *  4. Refreshes `supplier_products.last_price_millis` and
 *     `last_purchased_at` for every (supplier, ingredient) pair on the invoice.
 *
 * The invoice states which location took delivery, and that location is checked
 * against the caller before anything is written — it belongs to their
 * organization, and a site-bound member may only receive at their own site.
 * Previously the field was validated and then ignored in favour of the member's
 * default location, so a manager receiving a delivery at the Annex silently
 * added the stock to Main: no authorization hole, but every downstream figure —
 * on-hand balance, valuation, that site's next count variance — was wrong for
 * both branches.
 */
export async function receivePurchase(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const tenant = await requireTenantLocation();
    requirePermission(tenant.role, "manage_purchasing");
    const values = purchaseInput.parse(input);
    await assertMemberLocation(tenant, values.locationId, "receive purchases");
    const locationId = values.locationId;
    const db = getDb();
    const units = await getOrganizationUnits(tenant.organizationId);
    const scale = minorUnitScale(tenant.currency);

    // Resolve all ingredients in one query to enforce ownership, activeness and
    // the presence of every referenced id.
    const ingredientIds = [...new Set(values.items.map(item => item.ingredientId))];
    const ingredientRows = await db
      .select()
      .from(ingredients)
      .where(and(eq(ingredients.organizationId, tenant.organizationId), inArray(ingredients.id, ingredientIds)));
    if (ingredientRows.length !== ingredientIds.length) {
      const found = new Set(ingredientRows.map(row => row.id));
      const missing = ingredientIds.filter(id => !found.has(id));
      return actionError(`Ingredient${missing.length > 1 ? "s" : ""} not found: ${missing.join(", ")}.`);
    }
    const ingredientMap = new Map(ingredientRows.map(row => [row.id, row]));

    /**
     * The supplier, if one was named, must belong to this organization too.
     *
     * `purchases.supplier_id` has a foreign key but no tenant constraint — the
     * database cannot express "same organization as the purchase" — so without
     * this an invoice could be filed against another workspace's supplier. The
     * purchase list and detail screens join that row for its name, which turned
     * a cross-tenant *write* into a cross-tenant *read*: someone else's supplier
     * name rendered inside this workspace, and this workspace's spend attributed
     * to a supplier its owner cannot see.
     */
    const supplierId = values.supplierId ?? null;
    if (supplierId) {
      const [supplier] = await db
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(and(eq(suppliers.id, supplierId), eq(suppliers.organizationId, tenant.organizationId)))
        .limit(1);
      if (!supplier) return actionError("Supplier not found.", { supplierId: "Select a supplier from this workspace." });
    }

    const purchaseId = await db.transaction(async tx => {
      // 1. Compute line totals and the invoice-level aggregate.
      let totalMillis = 0;
      const lines = values.items.map((item, index) => {
        const ingredient = ingredientMap.get(item.ingredientId)!;
        const unitCostMinor = toMinorUnits(item.unitCost, tenant.currency);
        const quantity = Math.round(item.quantity * scale) / scale; // snap to currency precision
        const lineTotalMillis = Math.round(quantity * unitCostMinor);
        totalMillis += lineTotalMillis;

        // Convert to the ingredient's base unit for the stock ledger and cost tracking.
        const baseQuantity = toBaseQuantity(quantity, item.unitCode, ingredient.baseUnitCode, units);
        const baseUnitCostMillis = toBaseUnitCost(unitCostMinor, item.unitCode, ingredient.baseUnitCode, units);

        return {
          ingredientId: item.ingredientId,
          quantity: String(quantity),
          unitCode: item.unitCode,
          unitCostMillis: unitCostMinor,
          lineTotalMillis,
          baseQuantity: String(baseQuantity),
          baseUnitCostMillis: Math.round(baseUnitCostMillis),
          sortOrder: index,
          ingredient,
        };
      });

      // 2. Insert purchase header.
      const [purchase] = await tx
        .insert(purchases)
        .values({
          organizationId: tenant.organizationId,
          locationId,
          supplierId,
          invoiceNumber: values.invoiceNumber ?? null,
          status: "received",
          totalMillis,
          notes: values.notes ?? null,
          receivedAt: values.receivedAt ? new Date(values.receivedAt) : new Date(),
          createdBy: tenant.userId,
          clientOperationId: values.clientOperationId ?? null,
        })
        .returning();

      // 3. Insert every line.
      for (const line of lines) {
        await tx.insert(purchaseItems).values({
          purchaseId: purchase.id,
          ingredientId: line.ingredientId,
          quantity: line.quantity,
          unitCode: line.unitCode,
          unitCostMillis: line.unitCostMillis,
          lineTotalMillis: line.lineTotalMillis,
          baseQuantity: line.baseQuantity,
          baseUnitCostMillis: line.baseUnitCostMillis,
          sortOrder: line.sortOrder,
        });
      }

      // 4. Stock movements — one per line.
      for (const line of lines) {
        await tx.insert(stockMovements).values({
          organizationId: tenant.organizationId,
          locationId,
          ingredientId: line.ingredientId,
          type: "purchase",
          quantity: line.baseQuantity, // ledger entries are always base-unit
          unitCostMillis: line.baseUnitCostMillis ?? line.unitCostMillis,
          referenceType: "purchase",
          referenceId: purchase.id,
          performedBy: tenant.userId,
          occurredAt: purchase.receivedAt,
          clientOperationId: null, // per-line idempotency is handled by the purchase-level key
        });
      }

      // 5. Update ingredient latest cost and supplier product pricing.
      for (const line of lines) {
        if (line.baseUnitCostMillis && line.baseUnitCostMillis > 0) {
          await tx
            .update(ingredients)
            .set({ latestUnitCostMillis: line.baseUnitCostMillis, updatedAt: new Date() })
            .where(and(eq(ingredients.id, line.ingredientId), eq(ingredients.organizationId, tenant.organizationId)));
        }

        if (supplierId) {
          await tx
            .update(supplierProducts)
            .set({
              lastPriceMillis: line.unitCostMillis,
              lastPurchasedAt: purchase.receivedAt,
              packUnitCode: line.unitCode ?? line.ingredient.baseUnitCode,
              packQuantity: line.quantity,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(supplierProducts.organizationId, tenant.organizationId),
                eq(supplierProducts.supplierId, supplierId),
                eq(supplierProducts.ingredientId, line.ingredientId),
              ),
            );
        }
      }

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "create",
          entityType: "purchase",
          entityId: purchase.id,
          metadata: { supplierId, locationId, lineCount: lines.length, totalMillis },
        },
        tx,
      );

      return purchase.id;
    });

    revalidatePurchaseViews(purchaseId);
    return actionOk({ id: purchaseId });
  } catch (error) {
    return toActionError(error);
  }
}
