import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, locations, stockMovements, stockTransferItems, stockTransfers } from "@/db/schema";
import type { TransferStatus } from "@/lib/transfers";

/**
 * Transfer reads.
 *
 * Every query is scoped by `organizationId` in the WHERE clause rather than
 * filtered afterwards, so a transfer id from another tenant resolves to nothing
 * instead of revealing that it exists.
 *
 * Balances are never recomputed here. The transfers screens show what the
 * *document* says; what is on hand comes from `queries/inventory`, which sums
 * the one ledger. Two sources for "how much stock is there" is exactly what this
 * feature must not introduce.
 */

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type TransferRow = {
  id: string;
  reference: string | null;
  status: TransferStatus;
  sourceLocationId: string;
  sourceLocationName: string;
  destinationLocationId: string;
  destinationLocationName: string;
  createdByName: string | null;
  createdAt: Date;
  sentAt: Date | null;
  receivedAt: Date | null;
  itemCount: number;
  totalValueMillis: number;
};

/**
 * Transfers touching the given locations, newest first.
 *
 * `locationIds` is what the *member* may see: owners and managers pass every
 * location, while a site-bound member passes only their own, so the list itself
 * enforces the same boundary the actions do. Passing null lists the whole
 * organization.
 */
export async function listTransfers(
  organizationId: string,
  options: { locationIds?: string[] | null; limit?: number } = {},
): Promise<TransferRow[]> {
  const db = getDb();

  const conditions = [eq(stockTransfers.organizationId, organizationId)];
  if (options.locationIds) {
    if (!options.locationIds.length) return [];
    // A transfer is relevant to a member if either end is theirs — an outgoing
    // one they dispatched, or an incoming one they must receive.
    conditions.push(
      or(
        inArray(stockTransfers.sourceLocationId, options.locationIds),
        inArray(stockTransfers.destinationLocationId, options.locationIds),
      )!,
    );
  }

  const rows = await db
    .select({
      id: stockTransfers.id,
      reference: stockTransfers.reference,
      status: stockTransfers.status,
      sourceLocationId: stockTransfers.sourceLocationId,
      destinationLocationId: stockTransfers.destinationLocationId,
      createdAt: stockTransfers.createdAt,
      sentAt: stockTransfers.sentAt,
      receivedAt: stockTransfers.receivedAt,
    })
    .from(stockTransfers)
    .where(and(...conditions))
    .orderBy(desc(stockTransfers.createdAt))
    .limit(options.limit ?? 100);

  if (!rows.length) return [];

  // Location names and line totals are fetched in one query each rather than
  // one per transfer, the same shape `listStockCounts` uses.
  const locationRows = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(eq(locations.organizationId, organizationId));
  const locationName = new Map(locationRows.map(row => [row.id, row.name]));

  const items = await db
    .select({
      transferId: stockTransferItems.transferId,
      baseQuantity: stockTransferItems.baseQuantity,
      unitCostMillis: stockTransferItems.unitCostMillis,
    })
    .from(stockTransferItems)
    .where(inArray(stockTransferItems.transferId, rows.map(row => row.id)));

  const totals = new Map<string, { count: number; valueMillis: number }>();
  for (const item of items) {
    const entry = totals.get(item.transferId) ?? { count: 0, valueMillis: 0 };
    entry.count += 1;
    entry.valueMillis += Math.round(Number(item.baseQuantity) * item.unitCostMillis);
    totals.set(item.transferId, entry);
  }

  return rows.map(row => {
    const total = totals.get(row.id) ?? { count: 0, valueMillis: 0 };
    return {
      id: row.id,
      reference: row.reference,
      status: row.status as TransferStatus,
      sourceLocationId: row.sourceLocationId,
      sourceLocationName: locationName.get(row.sourceLocationId) ?? "Unknown",
      destinationLocationId: row.destinationLocationId,
      destinationLocationName: locationName.get(row.destinationLocationId) ?? "Unknown",
      createdByName: null,
      createdAt: row.createdAt,
      sentAt: row.sentAt,
      receivedAt: row.receivedAt,
      itemCount: total.count,
      totalValueMillis: total.valueMillis,
    };
  });
}

export type TransferDetailItem = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  quantity: number;
  unitCode: string | null;
  baseQuantity: number;
  baseUnitCode: string;
  unitCostMillis: number;
  valueMillis: number;
  /** What the source location holds right now, for the insufficient-stock warning. */
  availableAtSource: number;
};

export type TransferDetail = {
  id: string;
  reference: string | null;
  note: string | null;
  status: TransferStatus;
  sourceLocationId: string;
  sourceLocationName: string;
  destinationLocationId: string;
  destinationLocationName: string;
  createdByName: string | null;
  sentByName: string | null;
  receivedByName: string | null;
  createdAt: Date;
  sentAt: Date | null;
  receivedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  items: TransferDetailItem[];
  totalValueMillis: number;
};

/**
 * One transfer with its lines.
 *
 * `availableAtSource` is read live from the ledger rather than stored, so a
 * draft opened tomorrow shows today's availability. For a transfer already sent
 * it is informational only — the stock has left, and the figure shown is what
 * remains behind.
 */
export async function getTransfer(organizationId: string, transferId: string, tx?: Tx): Promise<TransferDetail | null> {
  const db = tx ?? getDb();

  const [row] = await db
    .select({
      id: stockTransfers.id,
      reference: stockTransfers.reference,
      note: stockTransfers.note,
      status: stockTransfers.status,
      sourceLocationId: stockTransfers.sourceLocationId,
      destinationLocationId: stockTransfers.destinationLocationId,
      createdAt: stockTransfers.createdAt,
      sentAt: stockTransfers.sentAt,
      receivedAt: stockTransfers.receivedAt,
      cancelledAt: stockTransfers.cancelledAt,
      cancelReason: stockTransfers.cancelReason,
    })
    .from(stockTransfers)
    .where(and(eq(stockTransfers.id, transferId), eq(stockTransfers.organizationId, organizationId)))
    .limit(1);

  if (!row) return null;

  const [locationRows, itemRows] = await Promise.all([
    db.select({ id: locations.id, name: locations.name }).from(locations).where(eq(locations.organizationId, organizationId)),
    db
      .select({
        id: stockTransferItems.id,
        ingredientId: stockTransferItems.ingredientId,
        ingredientName: ingredients.name,
        baseUnitCode: ingredients.baseUnitCode,
        quantity: stockTransferItems.quantity,
        unitCode: stockTransferItems.unitCode,
        baseQuantity: stockTransferItems.baseQuantity,
        unitCostMillis: stockTransferItems.unitCostMillis,
      })
      .from(stockTransferItems)
      .innerJoin(ingredients, eq(ingredients.id, stockTransferItems.ingredientId))
      .where(eq(stockTransferItems.transferId, transferId))
      .orderBy(asc(stockTransferItems.sortOrder)),
  ]);

  const locationName = new Map(locationRows.map(entry => [entry.id, entry.name]));

  const available = await availableAtLocation(
    organizationId,
    row.sourceLocationId,
    itemRows.map(item => item.ingredientId),
    tx,
  );

  const items: TransferDetailItem[] = itemRows.map(item => {
    const baseQuantity = Number(item.baseQuantity);
    return {
      id: item.id,
      ingredientId: item.ingredientId,
      ingredientName: item.ingredientName,
      quantity: Number(item.quantity),
      unitCode: item.unitCode,
      baseQuantity,
      baseUnitCode: item.baseUnitCode,
      unitCostMillis: item.unitCostMillis,
      valueMillis: Math.round(baseQuantity * item.unitCostMillis),
      availableAtSource: available.get(item.ingredientId) ?? 0,
    };
  });

  return {
    id: row.id,
    reference: row.reference,
    note: row.note,
    status: row.status as TransferStatus,
    sourceLocationId: row.sourceLocationId,
    sourceLocationName: locationName.get(row.sourceLocationId) ?? "Unknown",
    destinationLocationId: row.destinationLocationId,
    destinationLocationName: locationName.get(row.destinationLocationId) ?? "Unknown",
    createdByName: null,
    sentByName: null,
    receivedByName: null,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
    receivedAt: row.receivedAt,
    cancelledAt: row.cancelledAt,
    cancelReason: row.cancelReason,
    items,
    totalValueMillis: items.reduce((total, item) => total + item.valueMillis, 0),
  };
}

/**
 * On-hand quantity per ingredient at one location, from the ledger.
 *
 * The same `sum(quantity)` the inventory screen uses, narrowed to the
 * ingredients a transfer names. Deliberately not a second balance
 * implementation — it is the one ledger, filtered.
 *
 * Accepts a transaction so a send can read availability *inside* the same
 * transaction that writes the movements, which is what makes the check and the
 * write see a consistent view.
 */
export async function availableAtLocation(
  organizationId: string,
  locationId: string,
  ingredientIds: string[],
  tx?: Tx,
): Promise<Map<string, number>> {
  if (!ingredientIds.length) return new Map();
  const db = tx ?? getDb();

  const rows = await db
    .select({
      ingredientId: stockMovements.ingredientId,
      balance: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)`,
    })
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.organizationId, organizationId),
        eq(stockMovements.locationId, locationId),
        inArray(stockMovements.ingredientId, ingredientIds),
      ),
    )
    .groupBy(stockMovements.ingredientId);

  return new Map(rows.map(row => [row.ingredientId, Number(row.balance)]));
}

/** Ingredients with stock at a location, for the transfer builder's picker. */
export async function transferableIngredients(organizationId: string, locationId: string) {
  const rows = await getDb()
    .select({
      id: ingredients.id,
      name: ingredients.name,
      baseUnitCode: ingredients.baseUnitCode,
      unitCostMillis: ingredients.latestUnitCostMillis,
      stock: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)`,
    })
    .from(ingredients)
    .leftJoin(
      stockMovements,
      and(eq(stockMovements.ingredientId, ingredients.id), eq(stockMovements.locationId, locationId)),
    )
    .where(and(eq(ingredients.organizationId, organizationId), eq(ingredients.isActive, true)))
    .groupBy(ingredients.id)
    .orderBy(asc(ingredients.name));

  return rows.map(row => ({ ...row, stock: Number(row.stock) }));
}

/** Whether the workspace has ever made a transfer, for choosing an empty state. */
export async function hasAnyTransfers(organizationId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: stockTransfers.id })
    .from(stockTransfers)
    .where(eq(stockTransfers.organizationId, organizationId))
    .limit(1);
  return Boolean(row);
}
