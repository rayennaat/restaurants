import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, locations, stockMovements, wasteEntries } from "@/db/schema";
import { getInventoryValuation, type InventoryValueRow } from "@/server/queries/analytics";

export type InventoryRow = InventoryValueRow;

/**
 * Current balance per ingredient, summed from the append-only movement ledger.
 * Passing `locationId` scopes to one kitchen; passing null totals the whole org.
 * The Overview valuation query is the single source of truth for this shape and
 * its non-negative value calculation.
 */
export async function getInventory(organizationId: string, locationId: string | null): Promise<InventoryRow[]> {
  return getInventoryValuation({ organizationId, locationId });
}

/** Total value of stock on hand, used by the dashboard KPI and valuation report. */
export function inventoryValue(rows: InventoryRow[]) {
  return rows.reduce((total, row) => total + row.valueMillis, 0);
}

export function lowStockRows(rows: InventoryRow[]) {
  return rows.filter(row => row.stock > 0 && row.minimum > 0 && row.stock <= row.minimum);
}

export type MovementRow = {
  id: string;
  type: string;
  quantity: number;
  unitCostMillis: number;
  note: string | null;
  referenceType: string | null;
  referenceId: string | null;
  occurredAt: Date;
  ingredientName: string;
  unit: string;
  locationName: string;
};

/** Recent ledger entries, newest first — the audit trail behind every balance. */
export async function listStockMovements(organizationId: string, options: { locationId?: string | null; ingredientId?: string; limit?: number } = {}) {
  const conditions = [eq(stockMovements.organizationId, organizationId)];
  if (options.locationId) conditions.push(eq(stockMovements.locationId, options.locationId));
  if (options.ingredientId) conditions.push(eq(stockMovements.ingredientId, options.ingredientId));

  const rows = await getDb()
    .select({
      id: stockMovements.id,
      type: stockMovements.type,
      quantity: stockMovements.quantity,
      unitCostMillis: stockMovements.unitCostMillis,
      note: stockMovements.note,
      referenceType: stockMovements.referenceType,
      referenceId: stockMovements.referenceId,
      occurredAt: stockMovements.occurredAt,
      ingredientName: ingredients.name,
      unit: ingredients.baseUnitCode,
      locationName: locations.name,
    })
    .from(stockMovements)
    .innerJoin(ingredients, eq(ingredients.id, stockMovements.ingredientId))
    .innerJoin(locations, eq(locations.id, stockMovements.locationId))
    .where(and(...conditions))
    .orderBy(desc(stockMovements.occurredAt))
    .limit(options.limit ?? 50);

  return rows.map(row => ({ ...row, quantity: Number(row.quantity) })) as MovementRow[];
}

/** Daily waste cost for the last `days` days, zero-filled for charting. */
export async function getWasteTrend(organizationId: string, days = 7) {
  const rows = await getDb()
    .select({
      day: sql<string>`to_char(date_trunc('day', ${wasteEntries.occurredAt}), 'YYYY-MM-DD')`,
      cost: sql<string>`coalesce(sum(${wasteEntries.estimatedCostMillis}), 0)`,
    })
    .from(wasteEntries)
    .where(and(eq(wasteEntries.organizationId, organizationId), gte(wasteEntries.occurredAt, sql`now() - make_interval(days => ${days})`)))
    .groupBy(sql`date_trunc('day', ${wasteEntries.occurredAt})`);

  const byDay = new Map(rows.map(row => [row.day, Number(row.cost)]));
  const series: { day: string; label: string; cost: number }[] = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    series.push({ day: key, label: date.toLocaleDateString("en-GB", { weekday: "short" }), cost: byDay.get(key) ?? 0 });
  }
  return series;
}
