import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, locations, stockCountItems, stockCounts } from "@/db/schema";
import {
  calculateItemVariance,
  summarizeCount,
  type CountItemVariance,
  type CountSummary,
  type StockCountStatus,
} from "@/lib/stock-count";

/**
 * Stock count reads.
 *
 * Variance is never stored — it is derived on read from the snapshotted system
 * quantity, the counted quantity and the snapshotted unit cost, exactly like
 * recipe costing derives from live ingredient prices. Storing it would create a
 * second source of truth that could disagree with its own inputs.
 *
 * Every query is scoped by `organizationId` from the server tenant context.
 */

export type StockCountRow = {
  id: string;
  reference: string | null;
  status: StockCountStatus;
  locationId: string;
  locationName: string;
  createdByName: string | null;
  createdAt: Date;
  submittedAt: Date | null;
  approvedAt: Date | null;
  itemCount: number;
  countedCount: number;
  netValueMillis: number;
};

/** Count history for the list screen, newest first. */
export async function listStockCounts(
  organizationId: string,
  options: { locationId?: string | null; limit?: number } = {},
): Promise<StockCountRow[]> {
  const db = getDb();
  const conditions = [eq(stockCounts.organizationId, organizationId)];
  if (options.locationId) conditions.push(eq(stockCounts.locationId, options.locationId));

  const rows = await db
    .select({
      id: stockCounts.id,
      reference: stockCounts.reference,
      status: stockCounts.status,
      locationId: stockCounts.locationId,
      locationName: locations.name,
      createdAt: stockCounts.createdAt,
      submittedAt: stockCounts.submittedAt,
      approvedAt: stockCounts.approvedAt,
    })
    .from(stockCounts)
    .innerJoin(locations, eq(locations.id, stockCounts.locationId))
    .where(and(...conditions))
    .orderBy(desc(stockCounts.createdAt))
    .limit(options.limit ?? 50);

  if (!rows.length) return [];

  // One extra query for every line on the listed counts, rather than one query
  // per count — the totals are computed in memory from a single fetch.
  const items = await db
    .select({
      stockCountId: stockCountItems.stockCountId,
      systemQuantity: stockCountItems.systemQuantity,
      countedQuantity: stockCountItems.countedQuantity,
      unitCostMillis: stockCountItems.unitCostMillis,
    })
    .from(stockCountItems)
    .where(inArray(stockCountItems.stockCountId, rows.map(row => row.id)));

  const byCount = new Map<string, CountItemVariance[]>();
  for (const item of items) {
    const priced = calculateItemVariance({
      ingredientId: "",
      ingredientName: "",
      unit: "",
      systemQuantity: Number(item.systemQuantity),
      countedQuantity: item.countedQuantity === null ? null : Number(item.countedQuantity),
      unitCostMillis: item.unitCostMillis,
    });
    const bucket = byCount.get(item.stockCountId);
    if (bucket) bucket.push(priced);
    else byCount.set(item.stockCountId, [priced]);
  }

  return rows.map(row => {
    const summary = summarizeCount(byCount.get(row.id) ?? []);
    return {
      id: row.id,
      reference: row.reference,
      status: row.status as StockCountStatus,
      locationId: row.locationId,
      locationName: row.locationName,
      createdByName: null,
      createdAt: row.createdAt,
      submittedAt: row.submittedAt,
      approvedAt: row.approvedAt,
      itemCount: summary.itemCount,
      countedCount: summary.countedCount,
      netValueMillis: summary.netValueMillis,
    };
  });
}

export type StockCountDetail = {
  id: string;
  reference: string | null;
  note: string | null;
  status: StockCountStatus;
  locationId: string;
  locationName: string;
  createdByName: string | null;
  submittedByName: string | null;
  approvedByName: string | null;
  createdAt: Date;
  submittedAt: Date | null;
  approvedAt: Date | null;
  rejectionReason: string | null;
  items: (CountItemVariance & { id: string; countedUnitCode: string | null })[];
  summary: CountSummary;
};

/**
 * One count with its priced lines.
 *
 * Scoped by organization in the WHERE clause rather than checked afterwards, so
 * a count id from another tenant simply resolves to nothing.
 */
export async function getStockCount(organizationId: string, id: string): Promise<StockCountDetail | null> {
  const db = getDb();

  const [row] = await db
    .select({
      id: stockCounts.id,
      reference: stockCounts.reference,
      note: stockCounts.note,
      status: stockCounts.status,
      locationId: stockCounts.locationId,
      locationName: locations.name,
      createdAt: stockCounts.createdAt,
      submittedAt: stockCounts.submittedAt,
      approvedAt: stockCounts.approvedAt,
      rejectionReason: stockCounts.rejectionReason,
    })
    .from(stockCounts)
    .innerJoin(locations, eq(locations.id, stockCounts.locationId))
    .where(and(eq(stockCounts.id, id), eq(stockCounts.organizationId, organizationId)))
    .limit(1);

  if (!row) return null;

  const lines = await db
      .select({
        id: stockCountItems.id,
        ingredientId: stockCountItems.ingredientId,
        ingredientName: ingredients.name,
        unit: ingredients.baseUnitCode,
        systemQuantity: stockCountItems.systemQuantity,
        countedQuantity: stockCountItems.countedQuantity,
        countedUnitCode: stockCountItems.countedUnitCode,
        unitCostMillis: stockCountItems.unitCostMillis,
        note: stockCountItems.note,
        sortOrder: stockCountItems.sortOrder,
      })
      .from(stockCountItems)
      .innerJoin(ingredients, eq(ingredients.id, stockCountItems.ingredientId))
      .where(eq(stockCountItems.stockCountId, id))
      .orderBy(asc(stockCountItems.sortOrder), asc(ingredients.name));

  const items = lines.map(line => ({
    ...calculateItemVariance({
      ingredientId: line.ingredientId,
      ingredientName: line.ingredientName,
      unit: line.unit,
      systemQuantity: Number(line.systemQuantity),
      countedQuantity: line.countedQuantity === null ? null : Number(line.countedQuantity),
      unitCostMillis: line.unitCostMillis,
      note: line.note,
    }),
    id: line.id,
    countedUnitCode: line.countedUnitCode,
  }));

  return {
    id: row.id,
    reference: row.reference,
    note: row.note,
    status: row.status as StockCountStatus,
    locationId: row.locationId,
    locationName: row.locationName,
    createdByName: null,
    submittedByName: null,
    approvedByName: null,
    createdAt: row.createdAt,
    submittedAt: row.submittedAt,
    approvedAt: row.approvedAt,
    rejectionReason: row.rejectionReason,
    items,
    summary: summarizeCount(items),
  };
}

/** How many counts are waiting on an approver, for the dashboard/nav badge. */
export async function countAwaitingApproval(organizationId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: stockCounts.id })
    .from(stockCounts)
    .where(and(eq(stockCounts.organizationId, organizationId), eq(stockCounts.status, "submitted")));
  return rows.length;
}
