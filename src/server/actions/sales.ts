"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { menuItems, saleLines, sales } from "@/db/schema";
import { buildSaleLines, findMissingMenuItems, totalUnitsSold } from "@/lib/sales";
import { recordSaleInput, voidSaleInput } from "@/lib/validation";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { assertMemberLocation } from "@/server/queries/locations";
import { assertSaleStockAvailable, loadConsumptionRequirements, postSaleConsumption, reverseSaleConsumption } from "@/server/sale-consumption";
import { getOrganizationUnits, requirePermission, requireTenant, type MemberRole } from "@/server/tenant";
import { ActionError } from "@/lib/action-error";

/**
 * Recording and voiding sales.
 *
 * Two rules this file exists to uphold:
 *
 * **1. Historical pricing.** The price on a sale line is snapshotted from the
 * menu item at the moment of sale and never read back from `menu_items`
 * afterwards. Raise a burger from 20 DT to 22 DT and last month's revenue must
 * not move. The client never supplies a price at all — it names a menu item,
 * and the server resolves the price from its own catalog, so a tampered request
 * cannot invent revenue.
 *
 * **2. Selling depletes stock.** A dish leaving the kitchen takes its
 * ingredients with it, so recording a sale writes one negative
 * `sale_consumption` movement per ingredient the recipe expands to, in the same
 * transaction as the sale. Voiding reverses them. Without this the ledger only
 * ever rises — purchases add, waste subtracts, and the largest real outflow is
 * invisible — so every stock count reports a period's entire expected usage as
 * variance.
 *
 * The movements are an *inference* from recipes, and the `sale_consumption` type
 * is what keeps them distinguishable from observed movement (`purchase`,
 * `waste`, `stock_count_adjustment`). Variance stays meaningful because a count
 * compares the ledger against a quantity a human physically counted, which the
 * ledger does not feed. See `server/sale-consumption` for the full reasoning.
 *
 * The same pipeline serves manual entry and CSV/POS import: `source` and
 * `externalId` are part of the model, the unique index on
 * (organization, source, external_id) makes a re-run idempotent rather than
 * doubling revenue, and both paths post consumption through the same module.
 */

/** Location a member is allowed to post a sale against. Mirrors stock counts. */
async function assertLocationAllowed(
  tenant: { organizationId: string; role: MemberRole; locationId: string | null },
  locationId: string,
) {
  // Site-bound roles may only record sales at their own location, whatever the
  // form or import file said. The rule itself lives in `queries/locations`, so
  // every mutation that carries a location enforces the same one.
  await assertMemberLocation(tenant, locationId, "record sales");
}

function revalidateSalesViews(saleId?: string) {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/sales");
  if (saleId) revalidatePath(`/dashboard/sales/${saleId}`);
  revalidatePath("/dashboard/reports");
}

/**
 * Records one sale and its lines in a single transaction.
 *
 * Returns `{ duplicate: true }` rather than an error when the sale has already
 * been recorded under the same `(source, externalId)`. That is the behaviour an
 * importer wants: re-running yesterday's export should be a no-op it can report,
 * not a failure it has to interpret.
 */
export async function recordSale(input: unknown): Promise<ActionResult<{ id: string; duplicate: boolean }>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_sales");

    const values = recordSaleInput.parse(input);
    await assertLocationAllowed(tenant, values.locationId);

    const db = getDb();

    // Idempotency is checked before doing any work. The unique index is still
    // the real guarantee — two concurrent imports would both pass this check —
    // but returning the existing id here is friendlier than a constraint error.
    if (values.externalId) {
      const [existing] = await db
        .select({ id: sales.id })
        .from(sales)
        .where(
          and(
            eq(sales.organizationId, tenant.organizationId),
            eq(sales.source, values.source),
            eq(sales.externalId, values.externalId),
          ),
        )
        .limit(1);
      if (existing) return actionOk({ id: existing.id, duplicate: true });
    }

    // Resolve every referenced dish in one query, scoped to this organization.
    // This is both the tenant check and the source of the price snapshot: a
    // menu item id belonging to another workspace simply will not be found.
    const menuItemIds = [...new Set(values.items.map(item => item.menuItemId))];
    const catalog = await db
      .select({
        id: menuItems.id,
        name: menuItems.name,
        sellingPriceMillis: menuItems.sellingPriceMillis,
      })
      .from(menuItems)
      .where(and(eq(menuItems.organizationId, tenant.organizationId), inArray(menuItems.id, menuItemIds)));

    if (catalog.length !== menuItemIds.length) {
      const missing = findMissingMenuItems(values.items, catalog);
      return actionError(`Menu item${missing.length > 1 ? "s" : ""} not found in this workspace.`, {
        items: `Unknown menu item: ${missing.join(", ")}`,
      });
    }

    // Pricing is `lib/sales`, shared with the coming import path so the two can
    // never disagree about what a sale is worth.
    const { lines, totalMillis } = buildSaleLines(values.items, catalog);

    // Recipe expansion, loaded before the transaction opens so the graph queries
    // do not hold it open longer than the writes need.
    const units = await getOrganizationUnits(tenant.organizationId);
    const requirements = await loadConsumptionRequirements(tenant.organizationId, units);

    // Resolved once: evaluating `new Date()` separately for the sale and its
    // movements could straddle a tick and date them to different instants.
    const soldAt = values.soldAt ?? new Date();

    const saleId = await db.transaction(async tx => {
      await assertSaleStockAvailable(tx, {
        organizationId: tenant.organizationId,
        locationId: values.locationId,
        soldLines: values.items,
        requirements,
      });

      const [sale] = await tx
        .insert(sales)
        .values({
          organizationId: tenant.organizationId,
          locationId: values.locationId,
          source: values.source,
          status: "recorded",
          reference: values.reference ?? null,
          externalId: values.externalId ?? null,
          totalMillis,
          note: values.note ?? null,
          soldAt,
          createdBy: tenant.userId,
        })
        .returning({ id: sales.id });

      // `numeric` columns round-trip as strings in Drizzle; the quantity is
      // kept numeric through the pricing above and stringified only here.
      await tx.insert(saleLines).values(lines.map(line => ({ ...line, quantity: String(line.quantity), saleId: sale.id })));

      // The food leaving the kitchen. Same transaction as the sale, so a
      // rolled-back sale cannot leave stock depleted for a sale that never was.
      const movements = await postSaleConsumption(tx, {
        organizationId: tenant.organizationId,
        locationId: values.locationId,
        saleId: sale.id,
        soldAt,
        performedBy: tenant.userId,
        soldLines: values.items,
        requirements,
      });

      // Inside the transaction: revenue is money, so the record of who entered
      // it must not be able to go missing while the sale itself succeeds.
      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "sale_recorded",
          entityType: "sale",
          entityId: sale.id,
          metadata: {
            locationId: values.locationId,
            source: values.source,
            externalId: values.externalId ?? null,
            reference: values.reference ?? null,
            lineCount: lines.length,
            unitsSold: totalUnitsSold(values.items),
            totalMillis,
            consumptionMovements: movements,
          },
        },
        tx,
      );

      return sale.id;
    });

    revalidateSalesViews(saleId);
    return actionOk({ id: saleId, duplicate: false });
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Voids a sale.
 *
 * The row is kept and flagged, never deleted: revenue history that can silently
 * disappear is not history. Every revenue query filters on
 * `status = 'recorded'`, so a voided sale stops counting immediately while
 * remaining visible and explicable.
 *
 * Lines are frozen by a database trigger, so correcting a mistake means voiding
 * and re-recording — which leaves both the error and the correction on the
 * record.
 */
export async function voidSale(input: unknown): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_sales");

    const values = voidSaleInput.parse(input);
    const db = getDb();

    const [existing] = await db
      .select({ id: sales.id, locationId: sales.locationId, status: sales.status, totalMillis: sales.totalMillis })
      .from(sales)
      .where(and(eq(sales.id, values.saleId), eq(sales.organizationId, tenant.organizationId)))
      .limit(1);
    if (!existing) return actionError("Sale not found.");
    if (existing.status === "voided") return actionError("This sale has already been voided.");

    await assertLocationAllowed(tenant, existing.locationId);

    await db.transaction(async tx => {
      // Conditional on the status we read, so two people voiding at once cannot
      // both win and write two audit entries for one state change.
      const [updated] = await tx
        .update(sales)
        .set({
          status: "voided",
          voidedBy: tenant.userId,
          voidedAt: new Date(),
          voidReason: values.reason,
          updatedAt: new Date(),
        })
        .where(and(eq(sales.id, values.saleId), eq(sales.organizationId, tenant.organizationId), eq(sales.status, "recorded")))
        .returning({ id: sales.id });
      if (!updated) throw new ActionError("This sale has already been voided.");

      // The food comes back onto the books. Reversal is opposite movements
      // rather than deletions, so the ledger stays append-only and the
      // correction remains visible next to what it corrected.
      const reversed = await reverseSaleConsumption(tx, {
        organizationId: tenant.organizationId,
        saleId: values.saleId,
        performedBy: tenant.userId,
      });

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "sale_voided",
          entityType: "sale",
          entityId: values.saleId,
          metadata: { reason: values.reason, reversedTotalMillis: existing.totalMillis, reversedMovements: reversed },
        },
        tx,
      );
    });

    revalidateSalesViews(values.saleId);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}
