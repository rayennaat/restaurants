"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, stockCountItems, stockCounts, stockMovements } from "@/db/schema";
import { adjustableItems, isEditableStatus } from "@/lib/stock-count";
import { toBaseQuantity } from "@/lib/units";
import { createStockCountInput, rejectStockCountInput, saveStockCountEntriesInput } from "@/lib/validation";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { getInventory } from "@/server/queries/inventory";
import { getStockCount } from "@/server/queries/stock-counts";
import { assertMemberLocation } from "@/server/queries/locations";
import { getOrganizationUnits, requirePermission, requireTenant, type MemberRole } from "@/server/tenant";
import { ActionError } from "@/lib/action-error";

/**
 * Stock count workflow: draft → counting → submitted → approved/rejected.
 *
 * The rule the whole file exists to uphold: **a count never edits stock**.
 * Approval writes `stock_count_adjustment` movements into the ledger, which
 * remains the only thing that decides what is on hand. That keeps the history
 * intact — you can always see that a balance changed because of a count, who
 * approved it, and by how much.
 *
 * Counting and approving are separate permissions on purpose. An inventory
 * clerk may count and submit; only a manager or owner may approve, because
 * approval is what moves value.
 */

/** Location a member is allowed to post a count against. */
async function assertLocationAllowed(
  tenant: { organizationId: string; role: MemberRole; locationId: string | null },
  locationId: string,
) {
  // Site-bound roles may only count their own location, whatever the form said.
  await assertMemberLocation(tenant, locationId, "count stock");
}

/**
 * Opens a count sheet.
 *
 * The system quantity for each line is read from the ledger here and stored as
 * a snapshot — the counter must never be able to type it, and it must not drift
 * while the sheet is being filled in.
 */
export async function createStockCount(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_stock_counts");

    const values = createStockCountInput.parse(input);
    await assertLocationAllowed(tenant, values.locationId);

    // Balances come from the ledger, never from the request.
    const inventory = await getInventory(tenant.organizationId, values.locationId);

    let selected = inventory;
    if (values.scope === "category") {
      const category = values.category?.trim().toLowerCase();
      selected = inventory.filter(row => (row.category ?? "").trim().toLowerCase() === category);
    } else if (values.scope === "low_stock") {
      selected = inventory.filter(row => row.stock <= 0 || (row.minimum > 0 && row.stock <= row.minimum));
    } else if (values.scope === "selected") {
      const ids = new Set(values.ingredientIds ?? []);
      selected = inventory.filter(row => ids.has(row.id));
    }

    if (!selected.length) return actionError("No ingredients match that selection.");

    const db = getDb();
    const id = await db.transaction(async tx => {
      const [count] = await tx
        .insert(stockCounts)
        .values({
          organizationId: tenant.organizationId,
          locationId: values.locationId,
          status: "draft",
          reference: values.reference ?? null,
          note: values.note ?? null,
          createdBy: tenant.userId,
        })
        .returning({ id: stockCounts.id });

      await tx.insert(stockCountItems).values(
        selected.map((row, index) => ({
          stockCountId: count.id,
          ingredientId: row.id,
          systemQuantity: String(row.stock),
          unitCostMillis: row.unitCostMillis,
          sortOrder: index,
        })),
      );

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "stock_count_created",
          entityType: "stock_count",
          entityId: count.id,
          metadata: { locationId: values.locationId, scope: values.scope, itemCount: selected.length },
        },
        tx,
      );

      return count.id;
    });

    revalidatePath("/dashboard/inventory/counts");
    return actionOk({ id });
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Saves entered quantities.
 *
 * Quantities may be typed in any unit compatible with the ingredient's base
 * unit and are converted before storage, so the ledger only ever sees base
 * units. The status advances draft → counting on the first save.
 */
export async function saveStockCountEntries(input: unknown): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_stock_counts");

    const values = saveStockCountEntriesInput.parse(input);
    const db = getDb();

    const [count] = await db
      .select({ id: stockCounts.id, status: stockCounts.status, locationId: stockCounts.locationId })
      .from(stockCounts)
      .where(and(eq(stockCounts.id, values.stockCountId), eq(stockCounts.organizationId, tenant.organizationId)))
      .limit(1);
    if (!count) return actionError("That stock count does not exist.");
    if (!isEditableStatus(count.status)) return actionError("This count has been submitted and can no longer be edited.");
    await assertLocationAllowed(tenant, count.locationId);

    if (!values.entries.length) return actionOk();

    const units = await getOrganizationUnits(tenant.organizationId);

    // Re-fetch the lines so a forged itemId cannot write onto another count.
    const lines = await db
      .select({ id: stockCountItems.id, ingredientId: stockCountItems.ingredientId, baseUnitCode: ingredients.baseUnitCode })
      .from(stockCountItems)
      .innerJoin(ingredients, eq(ingredients.id, stockCountItems.ingredientId))
      .where(
        and(
          eq(stockCountItems.stockCountId, values.stockCountId),
          inArray(stockCountItems.id, values.entries.map(entry => entry.itemId)),
        ),
      );
    const byId = new Map(lines.map(line => [line.id, line]));

    await db.transaction(async tx => {
      for (const entry of values.entries) {
        const line = byId.get(entry.itemId);
        if (!line) continue;

        const baseQuantity =
          entry.countedQuantity === null
            ? null
            : toBaseQuantity(entry.countedQuantity, entry.unitCode ?? line.baseUnitCode, line.baseUnitCode, units);

        await tx
          .update(stockCountItems)
          .set({
            countedQuantity: baseQuantity === null ? null : String(baseQuantity),
            countedUnitCode: entry.unitCode ?? null,
            note: entry.note ?? null,
          })
          .where(eq(stockCountItems.id, entry.itemId));
      }

      if (count.status === "draft") {
        await tx.update(stockCounts).set({ status: "counting", updatedAt: new Date() }).where(eq(stockCounts.id, values.stockCountId));
      } else {
        await tx.update(stockCounts).set({ updatedAt: new Date() }).where(eq(stockCounts.id, values.stockCountId));
      }
    });

    revalidatePath(`/dashboard/inventory/counts/${values.stockCountId}`);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

/** Hands a completed sheet to an approver. Every line must have a figure. */
export async function submitStockCount(stockCountId: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_stock_counts");

    const detail = await getStockCount(tenant.organizationId, stockCountId);
    if (!detail) return actionError("That stock count does not exist.");
    if (!isEditableStatus(detail.status)) return actionError("This count has already been submitted.");
    await assertLocationAllowed(tenant, detail.locationId);
    if (!detail.summary.isComplete) {
      const missing = detail.summary.itemCount - detail.summary.countedCount;
      return actionError(`${missing} ingredient${missing === 1 ? " has" : "s have"} no counted quantity yet.`);
    }

    // Conditional on the status we read, so two people submitting at once
    // cannot both win. The audit row shares the transaction with the status.
    const submitted = await getDb().transaction(async tx => {
      const [updated] = await tx
        .update(stockCounts)
        .set({ status: "submitted", submittedBy: tenant.userId, submittedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(stockCounts.id, stockCountId),
            eq(stockCounts.organizationId, tenant.organizationId),
            inArray(stockCounts.status, ["draft", "counting"]),
          ),
        )
        .returning({ id: stockCounts.id });
      if (!updated) return false;

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "stock_count_submitted",
          entityType: "stock_count",
          entityId: stockCountId,
          metadata: {
            itemCount: detail.summary.itemCount,
            varianceCount: detail.summary.varianceCount,
            netValueMillis: detail.summary.netValueMillis,
          },
        },
        tx,
      );
      return true;
    });
    if (!submitted) return actionError("This count has already been submitted.");

    revalidatePath("/dashboard/inventory/counts");
    revalidatePath(`/dashboard/inventory/counts/${stockCountId}`);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Approves a count and writes the adjustments.
 *
 * One movement per varying line, of `counted − system` — the *delta*, not the
 * counted figure. If a delivery was received between counting and approval, the
 * delta lands on top of it; overwriting with the counted figure would silently
 * erase that delivery.
 *
 * The status flip is the concurrency guard: it is conditional on the count
 * still being `submitted` and happens in the same transaction as the movements,
 * so approving twice cannot double-post.
 */
export async function approveStockCount(stockCountId: string): Promise<ActionResult<{ movements: number }>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "approve_stock_counts");

    const detail = await getStockCount(tenant.organizationId, stockCountId);
    if (!detail) return actionError("That stock count does not exist.");
    if (detail.status !== "submitted") return actionError("Only a submitted count can be approved.");
    // Unreachable today — `approve_stock_counts` is owner/manager, and both span
    // every location — but stated so that adding a site-bound approver role can
    // never silently grant approval over another branch's ledger.
    await assertLocationAllowed(tenant, detail.locationId);

    const adjustments = adjustableItems(detail.items);
    const db = getDb();

    const movements = await db.transaction(async tx => {
      const [claimed] = await tx
        .update(stockCounts)
        .set({ status: "approved", approvedBy: tenant.userId, approvedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(stockCounts.id, stockCountId),
            eq(stockCounts.organizationId, tenant.organizationId),
            eq(stockCounts.status, "submitted"),
          ),
        )
        .returning({ id: stockCounts.id });

      // Somebody else approved or rejected it first.
      if (!claimed) throw new ActionError("This count is no longer awaiting approval.");

      if (adjustments.length) {
        await tx.insert(stockMovements).values(
          adjustments.map(item => ({
            organizationId: tenant.organizationId,
            locationId: detail.locationId,
            ingredientId: item.ingredientId,
            type: "stock_count_adjustment" as const,
            quantity: String(item.varianceQuantity),
            unitCostMillis: item.unitCostMillis,
            referenceType: "stock_count",
            referenceId: stockCountId,
            note: `Count ${detail.reference ?? stockCountId.slice(0, 8)}: system ${item.systemQuantity} → counted ${item.countedQuantity}`,
            performedBy: tenant.userId,
          })),
        );
      }

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "stock_count_approved",
          entityType: "stock_count",
          entityId: stockCountId,
          metadata: {
            locationId: detail.locationId,
            locationName: detail.locationName,
            itemCount: detail.summary.itemCount,
            varianceCount: detail.summary.varianceCount,
            positiveValueMillis: detail.summary.positiveValueMillis,
            negativeValueMillis: detail.summary.negativeValueMillis,
            netValueMillis: detail.summary.netValueMillis,
            movementsCreated: adjustments.length,
          },
        },
        tx,
      );

      return adjustments.length;
    });

    // Balances changed, so every screen derived from the ledger is now stale.
    revalidatePath("/dashboard");
    revalidatePath("/dashboard/inventory");
    revalidatePath("/dashboard/reports");
    revalidatePath("/dashboard/inventory/counts");
    revalidatePath(`/dashboard/inventory/counts/${stockCountId}`);
    return actionOk({ movements });
  } catch (error) {
    return toActionError(error);
  }
}

/** Sends a count back with a reason. Rejection never touches the ledger. */
export async function rejectStockCount(input: unknown): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "approve_stock_counts");

    const values = rejectStockCountInput.parse(input);

    const db = getDb();
    const [count] = await db
      .select({ locationId: stockCounts.locationId })
      .from(stockCounts)
      .where(and(eq(stockCounts.id, values.stockCountId), eq(stockCounts.organizationId, tenant.organizationId)))
      .limit(1);
    if (!count) return actionError("That stock count does not exist.");
    // Same defence as approval: today's approver roles span the organization, so
    // this only bites if that ever stops being true.
    await assertLocationAllowed(tenant, count.locationId);

    const rejected = await db.transaction(async tx => {
      const [updated] = await tx
        .update(stockCounts)
        .set({
          status: "rejected",
          rejectionReason: values.reason,
          approvedBy: tenant.userId,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stockCounts.id, values.stockCountId),
            eq(stockCounts.organizationId, tenant.organizationId),
            eq(stockCounts.status, "submitted"),
          ),
        )
        .returning({ id: stockCounts.id });
      if (!updated) return false;

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "stock_count_rejected",
          entityType: "stock_count",
          entityId: values.stockCountId,
          metadata: { reason: values.reason },
        },
        tx,
      );
      return true;
    });

    if (!rejected) return actionError("Only a submitted count can be rejected.");

    revalidatePath("/dashboard/inventory/counts");
    revalidatePath(`/dashboard/inventory/counts/${values.stockCountId}`);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Discards a sheet that was never submitted.
 *
 * Location-checked like every other count action. It is the one that used to
 * skip the check, and the omission mattered precisely because `manage_stock_counts`
 * includes the site-bound `inventory` role: passing another branch's count id
 * destroyed that branch's work — a draft is hours of shelf-walking — from a
 * screen that never lists it.
 *
 * Audited inside the transaction, matching every other deletion in the codebase:
 * the row is gone afterwards, so a record that fails on its own leaves no trace
 * that the count ever existed.
 */
export async function deleteStockCount(stockCountId: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_stock_counts");

    const db = getDb();
    const [count] = await db
      .select({ locationId: stockCounts.locationId, status: stockCounts.status, reference: stockCounts.reference })
      .from(stockCounts)
      .where(and(eq(stockCounts.id, stockCountId), eq(stockCounts.organizationId, tenant.organizationId)))
      .limit(1);
    if (!count) return actionError("That stock count does not exist.");
    await assertLocationAllowed(tenant, count.locationId);

    const deleted = await db.transaction(async tx => {
      const [row] = await tx
        .delete(stockCounts)
        .where(
          and(
            eq(stockCounts.id, stockCountId),
            eq(stockCounts.organizationId, tenant.organizationId),
            inArray(stockCounts.status, ["draft", "counting"]),
          ),
        )
        .returning({ id: stockCounts.id });
      if (!row) return null;

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "stock_count_discarded",
          entityType: "stock_count",
          entityId: stockCountId,
          metadata: { locationId: count.locationId, reference: count.reference },
        },
        tx,
      );
      return row;
    });

    if (!deleted) return actionError("Only a draft count can be discarded.");

    revalidatePath("/dashboard/inventory/counts");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}
