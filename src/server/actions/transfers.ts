"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, stockMovements, stockTransferItems, stockTransfers } from "@/db/schema";
import {
  describeShortfalls,
  findMissingIngredients,
  findShortfalls,
  prepareTransferLines,
  transferValueMillis,
  type PreparedTransferLine,
} from "@/lib/transfers";
import { cancelTransferInput, createTransferInput, transferIdInput } from "@/lib/validation";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { listLocationOptions } from "@/server/queries/locations";
import { availableAtLocation, getTransfer } from "@/server/queries/transfers";
import { canAccessAllLocations, getOrganizationUnits, requirePermission, requireTenant, type TenantContext } from "@/server/tenant";
import { ActionError } from "@/lib/action-error";

/**
 * Moving stock between locations.
 *
 * The design in one line: **a transfer is a document; `stock_movements` is still
 * the only thing that decides what is on hand.** Nothing here computes or caches
 * a balance — sending and receiving each append to the same ledger the inventory
 * screen, the valuation report and stock counts already read.
 *
 * ## Two legs
 *
 * Sending writes one `transfer_out` per line at the source. Receiving writes one
 * `transfer_in` per line at the destination. Between the two the goods are in
 * transit — deliberately in neither balance, because neither shelf holds them.
 * A van that never arrives therefore surfaces as a transfer stuck in `sent`,
 * rather than as stock that exists in two places at once.
 *
 * ## Authorization is per end, not per transfer
 *
 * Sending is checked against the *source*; receiving against the *destination*.
 * That is what lets a site-bound member dispatch their own stock and accept
 * deliveries, without being able to reach into another branch. Owners, managers
 * and accountants span every location, exactly as elsewhere.
 *
 * ## Why every state change is a conditional UPDATE
 *
 * Each transition claims the row with `WHERE status = <expected>` inside the
 * same transaction that writes the movements. Two people pressing "Confirm
 * received" at once therefore produce one winner and one "already received"
 * message — the loser's UPDATE matches zero rows and its movements roll back
 * with it. A read-then-write check would let both pass and double the stock.
 */

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Locations this member may act on.
 *
 * Site-bound roles are pinned to their own location; everyone else spans the
 * organization. Returned as ids so callers can check either end of a transfer
 * against the same list.
 */
async function authorizedLocationIds(tenant: TenantContext): Promise<string[]> {
  const options = await listLocationOptions(tenant.organizationId);
  if (canAccessAllLocations(tenant.role)) return options.map(option => option.id);
  return options.filter(option => option.id === tenant.locationId).map(option => option.id);
}

/**
 * Asserts the caller may act on one end of a transfer.
 *
 * `ownsLocation` is implied: the list comes from the organization's own
 * locations, so an id belonging to another tenant is absent and fails here.
 */
function assertLocationAllowed(allowed: string[], locationId: string, action: string) {
  if (!allowed.includes(locationId)) {
    throw new ActionError(`You are not authorized to ${action} at that location.`);
  }
}

function revalidateTransferViews(transferId?: string) {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/transfers");
  if (transferId) revalidatePath(`/dashboard/transfers/${transferId}`);
  revalidatePath("/dashboard/inventory");
  revalidatePath("/dashboard/reports");
}

/** Loads the transfer's lines in ledger form, inside the caller's transaction. */
async function transferLinesForLedger(tx: Tx, transferId: string) {
  return tx
    .select({
      ingredientId: stockTransferItems.ingredientId,
      baseQuantity: stockTransferItems.baseQuantity,
      unitCostMillis: stockTransferItems.unitCostMillis,
    })
    .from(stockTransferItems)
    .where(eq(stockTransferItems.transferId, transferId));
}

/**
 * Writes one leg of a transfer into the ledger.
 *
 * `direction` decides both the movement type and the sign: out is negative at
 * the source, in is positive at the destination. Quantities are already in the
 * ingredient's base unit — the conversion happened once, when the document was
 * created.
 */
async function postTransferLeg(
  tx: Tx,
  input: {
    organizationId: string;
    locationId: string;
    transferId: string;
    performedBy: string | null;
    direction: "out" | "in";
    lines: { ingredientId: string; baseQuantity: string; unitCostMillis: number }[];
    note: string;
  },
) {
  if (!input.lines.length) return 0;

  await tx.insert(stockMovements).values(
    input.lines.map(line => ({
      organizationId: input.organizationId,
      locationId: input.locationId,
      ingredientId: line.ingredientId,
      type: (input.direction === "out" ? "transfer_out" : "transfer_in") as "transfer_out" | "transfer_in",
      quantity: input.direction === "out" ? String(-Number(line.baseQuantity)) : String(Number(line.baseQuantity)),
      unitCostMillis: line.unitCostMillis,
      referenceType: "stock_transfer",
      referenceId: input.transferId,
      performedBy: input.performedBy,
      note: input.note,
    })),
  );

  return input.lines.length;
}

/**
 * Creates a transfer, optionally sending it immediately.
 *
 * Ingredients are resolved in one query scoped to the caller's organization,
 * which is both the existence check and the cross-tenant boundary: an id from
 * another workspace simply does not resolve.
 *
 * Availability is verified *inside* the transaction when sending, so the check
 * and the movements see one consistent view of the ledger.
 */
export async function createTransfer(input: unknown): Promise<ActionResult<{ id: string; status: string }>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "record_operations");

    const values = createTransferInput.parse(input);

    const allowed = await authorizedLocationIds(tenant);
    // Both ends must belong to the organization; the source must additionally be
    // one this member may dispatch from.
    assertLocationAllowed(allowed, values.sourceLocationId, "send stock");
    const organizationLocations = (await listLocationOptions(tenant.organizationId)).map(option => option.id);
    if (!organizationLocations.includes(values.destinationLocationId)) {
      return actionError("That destination does not belong to this workspace.");
    }
    if (values.sourceLocationId === values.destinationLocationId) {
      return actionError("Choose a different destination — stock cannot transfer to the location it is already in.");
    }

    const db = getDb();
    const units = await getOrganizationUnits(tenant.organizationId);

    const ingredientIds = [...new Set(values.items.map(item => item.ingredientId))];
    const catalog = await db
      .select({
        id: ingredients.id,
        name: ingredients.name,
        baseUnitCode: ingredients.baseUnitCode,
        unitCostMillis: ingredients.latestUnitCostMillis,
      })
      .from(ingredients)
      .where(and(eq(ingredients.organizationId, tenant.organizationId), inArray(ingredients.id, ingredientIds)));

    if (catalog.length !== ingredientIds.length) {
      const missing = findMissingIngredients(values.items, catalog);
      return actionError(`Ingredient${missing.length > 1 ? "s" : ""} not found in this workspace.`, {
        items: `Unknown ingredient: ${missing.join(", ")}`,
      });
    }

    let lines: PreparedTransferLine[];
    try {
      lines = prepareTransferLines(values.items, catalog, units);
    } catch {
      // Conversion helpers may include internal unit details in their exception.
      // The payload has already been validated, so expose one controlled message.
      return actionError("One or more transfer quantities use an incompatible unit.");
    }

    const result = await db.transaction(async tx => {
      // Read inside the transaction so the availability check and the movements
      // that depend on it cannot be separated by another write.
      if (values.sendNow) {
        const available = await availableAtLocation(
          tenant.organizationId,
          values.sourceLocationId,
          lines.map(line => line.ingredientId),
          tx,
        );
        const shortfalls = findShortfalls(lines, available);
        if (shortfalls.length) {
          throw new ActionError(`Not enough stock at the source. ${describeShortfalls(shortfalls)}.`);
        }
      }

      const now = new Date();
      const [transfer] = await tx
        .insert(stockTransfers)
        .values({
          organizationId: tenant.organizationId,
          sourceLocationId: values.sourceLocationId,
          destinationLocationId: values.destinationLocationId,
          status: values.sendNow ? "sent" : "draft",
          reference: values.reference ?? null,
          note: values.note ?? null,
          createdBy: tenant.userId,
          sentBy: values.sendNow ? tenant.userId : null,
          sentAt: values.sendNow ? now : null,
        })
        .returning({ id: stockTransfers.id, status: stockTransfers.status });

      await tx.insert(stockTransferItems).values(
        lines.map(line => ({
          transferId: transfer.id,
          ingredientId: line.ingredientId,
          quantity: String(line.quantity),
          unitCode: line.unitCode,
          baseQuantity: String(line.baseQuantity),
          unitCostMillis: line.unitCostMillis,
          sortOrder: line.sortOrder,
        })),
      );

      if (values.sendNow) {
        await postTransferLeg(tx, {
          organizationId: tenant.organizationId,
          locationId: values.sourceLocationId,
          transferId: transfer.id,
          performedBy: tenant.userId,
          direction: "out",
          lines: lines.map(line => ({
            ingredientId: line.ingredientId,
            baseQuantity: String(line.baseQuantity),
            unitCostMillis: line.unitCostMillis,
          })),
          note: `Transfer ${values.reference ?? transfer.id.slice(0, 8)} sent`,
        });
      }

      // Inside the transaction: a transfer moves value between sites, so the
      // record of who set it in motion must not be able to go missing while the
      // stock does move.
      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: values.sendNow ? "transfer_sent" : "transfer_created",
          entityType: "stock_transfer",
          entityId: transfer.id,
          metadata: {
            sourceLocationId: values.sourceLocationId,
            destinationLocationId: values.destinationLocationId,
            reference: values.reference ?? null,
            lineCount: lines.length,
            totalValueMillis: transferValueMillis(lines),
            movementsCreated: values.sendNow ? lines.length : 0,
          },
        },
        tx,
      );

      return transfer;
    });

    revalidateTransferViews(result.id);
    return actionOk({ id: result.id, status: result.status });
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Dispatches a draft: deducts the stock from the source.
 *
 * The status flip is conditional on the transfer still being a draft, in the
 * same transaction as the movements, so two people sending at once produce one
 * dispatch rather than two deductions.
 */
export async function sendTransfer(input: unknown): Promise<ActionResult<{ movements: number }>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "record_operations");

    const values = transferIdInput.parse(input);
    const detail = await getTransfer(tenant.organizationId, values.transferId);
    if (!detail) return actionError("That transfer does not exist.");
    if (detail.status !== "draft") return actionError("Only a draft transfer can be sent.");
    if (!detail.items.length) return actionError("Add at least one ingredient before sending.");

    const allowed = await authorizedLocationIds(tenant);
    assertLocationAllowed(allowed, detail.sourceLocationId, "send stock");

    const db = getDb();

    const movements = await db.transaction(async tx => {
      const lines = await transferLinesForLedger(tx, values.transferId);

      const available = await availableAtLocation(
        tenant.organizationId,
        detail.sourceLocationId,
        lines.map(line => line.ingredientId),
        tx,
      );
      const shortfalls = findShortfalls(
        detail.items.map(item => ({
          ingredientId: item.ingredientId,
          ingredientName: item.ingredientName,
          quantity: item.quantity,
          unitCode: item.unitCode ?? item.baseUnitCode,
          baseQuantity: item.baseQuantity,
          baseUnitCode: item.baseUnitCode,
          unitCostMillis: item.unitCostMillis,
          valueMillis: item.valueMillis,
          sortOrder: 0,
        })),
        available,
      );
      if (shortfalls.length) {
        throw new ActionError(`Not enough stock at the source. ${describeShortfalls(shortfalls)}.`);
      }

      const [claimed] = await tx
        .update(stockTransfers)
        .set({ status: "sent", sentBy: tenant.userId, sentAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(stockTransfers.id, values.transferId),
            eq(stockTransfers.organizationId, tenant.organizationId),
            eq(stockTransfers.status, "draft"),
          ),
        )
        .returning({ id: stockTransfers.id });

      // Somebody else sent or cancelled it first.
      if (!claimed) throw new ActionError("This transfer has already been sent.");

      const posted = await postTransferLeg(tx, {
        organizationId: tenant.organizationId,
        locationId: detail.sourceLocationId,
        transferId: values.transferId,
        performedBy: tenant.userId,
        direction: "out",
        lines: lines.map(line => ({
          ingredientId: line.ingredientId,
          baseQuantity: String(line.baseQuantity),
          unitCostMillis: line.unitCostMillis,
        })),
        note: `Transfer ${detail.reference ?? values.transferId.slice(0, 8)} sent to ${detail.destinationLocationName}`,
      });

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "transfer_sent",
          entityType: "stock_transfer",
          entityId: values.transferId,
          metadata: {
            sourceLocationId: detail.sourceLocationId,
            destinationLocationId: detail.destinationLocationId,
            lineCount: lines.length,
            totalValueMillis: detail.totalValueMillis,
            movementsCreated: posted,
          },
        },
        tx,
      );

      return posted;
    });

    revalidateTransferViews(values.transferId);
    return actionOk({ movements });
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Confirms arrival: adds the stock to the destination.
 *
 * Authorized against the *destination*, so the person unpacking the van is the
 * one who signs for it. The conditional UPDATE is what makes a double-click, a
 * retried request and two colleagues confirming at once all produce exactly one
 * set of `transfer_in` movements.
 */
export async function receiveTransfer(input: unknown): Promise<ActionResult<{ movements: number }>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "record_operations");

    const values = transferIdInput.parse(input);
    const detail = await getTransfer(tenant.organizationId, values.transferId);
    if (!detail) return actionError("That transfer does not exist.");
    if (detail.status === "received") return actionError("This transfer has already been received.");
    if (detail.status !== "sent") return actionError("Only a transfer that has been sent can be received.");

    const allowed = await authorizedLocationIds(tenant);
    assertLocationAllowed(allowed, detail.destinationLocationId, "receive stock");

    const db = getDb();

    const movements = await db.transaction(async tx => {
      const [claimed] = await tx
        .update(stockTransfers)
        .set({ status: "received", receivedBy: tenant.userId, receivedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(stockTransfers.id, values.transferId),
            eq(stockTransfers.organizationId, tenant.organizationId),
            eq(stockTransfers.status, "sent"),
          ),
        )
        .returning({ id: stockTransfers.id });

      // The guard against double-receiving. A read-then-write check would let
      // two concurrent confirmations both pass and double the destination's
      // stock; matching zero rows here rolls this attempt back entirely.
      if (!claimed) throw new ActionError("This transfer has already been received.");

      const lines = await transferLinesForLedger(tx, values.transferId);
      const posted = await postTransferLeg(tx, {
        organizationId: tenant.organizationId,
        locationId: detail.destinationLocationId,
        transferId: values.transferId,
        performedBy: tenant.userId,
        direction: "in",
        lines: lines.map(line => ({
          ingredientId: line.ingredientId,
          baseQuantity: String(line.baseQuantity),
          unitCostMillis: line.unitCostMillis,
        })),
        note: `Transfer ${detail.reference ?? values.transferId.slice(0, 8)} received from ${detail.sourceLocationName}`,
      });

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "transfer_received",
          entityType: "stock_transfer",
          entityId: values.transferId,
          metadata: {
            sourceLocationId: detail.sourceLocationId,
            destinationLocationId: detail.destinationLocationId,
            lineCount: lines.length,
            totalValueMillis: detail.totalValueMillis,
            movementsCreated: posted,
          },
        },
        tx,
      );

      return posted;
    });

    revalidateTransferViews(values.transferId);
    return actionOk({ movements });
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Cancels a transfer.
 *
 * What this does depends on where the stock is. Cancelling a draft touches no
 * movements — nothing ever left. Cancelling a *sent* transfer returns the goods
 * to the source with compensating `transfer_in` movements, because the stock is
 * on a van that turned back and must land somewhere rather than evaporate.
 *
 * Requires `manage_stock_counts` rather than `record_operations`: reversing
 * dispatched stock is a supervisory correction, and that permission already
 * names exactly the roles (owner, manager, inventory) who own stock accuracy.
 */
export async function cancelTransfer(input: unknown): Promise<ActionResult<{ movements: number }>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_stock_counts");

    const values = cancelTransferInput.parse(input);
    const detail = await getTransfer(tenant.organizationId, values.transferId);
    if (!detail) return actionError("That transfer does not exist.");
    if (detail.status === "received") return actionError("A received transfer cannot be cancelled. Transfer the stock back instead.");
    if (detail.status === "cancelled") return actionError("This transfer has already been cancelled.");

    const allowed = await authorizedLocationIds(tenant);
    // Cancelling returns stock to the source, so the source is the end that
    // matters — the same location the goods came out of.
    assertLocationAllowed(allowed, detail.sourceLocationId, "cancel a transfer");

    const wasSent = detail.status === "sent";
    const db = getDb();

    const movements = await db.transaction(async tx => {
      const [claimed] = await tx
        .update(stockTransfers)
        .set({
          status: "cancelled",
          cancelledBy: tenant.userId,
          cancelledAt: new Date(),
          cancelReason: values.reason,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(stockTransfers.id, values.transferId),
            eq(stockTransfers.organizationId, tenant.organizationId),
            // Conditional on the status just read, so a transfer received
            // between the read and the write is not silently cancelled.
            eq(stockTransfers.status, wasSent ? "sent" : "draft"),
          ),
        )
        .returning({ id: stockTransfers.id });

      if (!claimed) throw new ActionError("This transfer is no longer in a state that can be cancelled.");

      let posted = 0;
      if (wasSent) {
        const lines = await transferLinesForLedger(tx, values.transferId);
        // Compensating movements rather than deleting the originals: the ledger
        // is append-only, so the dispatch and its reversal both stay visible.
        posted = await postTransferLeg(tx, {
          organizationId: tenant.organizationId,
          locationId: detail.sourceLocationId,
          transferId: values.transferId,
          performedBy: tenant.userId,
          direction: "in",
          lines: lines.map(line => ({
            ingredientId: line.ingredientId,
            baseQuantity: String(line.baseQuantity),
            unitCostMillis: line.unitCostMillis,
          })),
          note: `Transfer ${detail.reference ?? values.transferId.slice(0, 8)} cancelled — returned to ${detail.sourceLocationName}`,
        });
      }

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "transfer_cancelled",
          entityType: "stock_transfer",
          entityId: values.transferId,
          metadata: {
            reason: values.reason,
            sourceLocationId: detail.sourceLocationId,
            destinationLocationId: detail.destinationLocationId,
            wasSent,
            movementsCreated: posted,
          },
        },
        tx,
      );

      return posted;
    });

    revalidateTransferViews(values.transferId);
    return actionOk({ movements });
  } catch (error) {
    return toActionError(error);
  }
}
