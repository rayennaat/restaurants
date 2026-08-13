import { and, asc, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, locations, purchaseItems, purchases, stockMovements, suppliers, wasteEntries } from "@/db/schema";
import { bucketStarts, percentChange, type DateRange, type Granularity } from "@/lib/date-range";

/**
 * Aggregated analytics for the dashboard and reports.
 *
 * Everything here is grouped and summed by PostgreSQL rather than in React: the
 * dashboard must stay responsive on an organization with years of movements, and
 * pulling a ledger into memory to `reduce()` it would not.
 *
 * Every query takes `organizationId` from the server-side tenant context and
 * filters on it. `locationId` is optional — null means the whole organization —
 * and is validated by `resolveLocation` before it reaches any function here.
 */

export type Scope = {
  organizationId: string;
  /** Null totals every location in the organization. */
  locationId: string | null;
};

/** A figure with its previous-period comparison. */
export type PeriodMetric = {
  current: number;
  previous: number;
  /** Null when the previous period was zero — no trend can be inferred from nothing. */
  changePercent: number | null;
};

const toNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Maps Postgres' `date_trunc` unit onto the range granularity. */
const truncUnit = (granularity: Granularity) => (granularity === "month" ? "month" : granularity === "week" ? "week" : "day");

// --------------------------------------------------------------------- purchases

/**
 * Total received-invoice value in the period, against the previous period.
 *
 * Only `received` invoices count: a draft has not entered stock, and a cancelled
 * one never will.
 */
export async function getPurchaseTotals(scope: Scope, range: DateRange): Promise<PeriodMetric & { invoiceCount: number }> {
  const base = (from: Date, to: Date) => {
    const conditions = [eq(purchases.organizationId, scope.organizationId), eq(purchases.status, "received"), gte(purchases.receivedAt, from), lt(purchases.receivedAt, to)];
    if (scope.locationId) conditions.push(eq(purchases.locationId, scope.locationId));
    return getDb()
      .select({ total: sql<string>`coalesce(sum(${purchases.totalMillis}), 0)`, invoices: count() })
      .from(purchases)
      .where(and(...conditions));
  };

  const [[current], [previous]] = await Promise.all([base(range.from, range.to), base(range.previousFrom, range.previousTo)]);

  const currentTotal = toNumber(current?.total);
  const previousTotal = toNumber(previous?.total);
  return { current: currentTotal, previous: previousTotal, changePercent: percentChange(currentTotal, previousTotal), invoiceCount: toNumber(current?.invoices) };
}

// ------------------------------------------------------------------------- waste

export type WasteSummary = {
  cost: PeriodMetric;
  /** Quantity is summed in ingredient base units. */
  quantity: number;
  events: number;
  /** How many distinct ingredients were wasted. */
  ingredientCount: number;
};

/** Waste cost, quantity and event count for the period, with a cost comparison. */
export async function getWasteSummary(scope: Scope, range: DateRange): Promise<WasteSummary> {
  const base = (from: Date, to: Date) => {
    const conditions = [eq(wasteEntries.organizationId, scope.organizationId), gte(wasteEntries.occurredAt, from), lt(wasteEntries.occurredAt, to)];
    if (scope.locationId) conditions.push(eq(wasteEntries.locationId, scope.locationId));
    return getDb()
      .select({
        cost: sql<string>`coalesce(sum(${wasteEntries.estimatedCostMillis}), 0)`,
        quantity: sql<string>`coalesce(sum(${wasteEntries.quantity}), 0)`,
        events: count(),
        ingredientCount: sql<string>`count(distinct ${wasteEntries.ingredientId})`,
      })
      .from(wasteEntries)
      .where(and(...conditions));
  };

  const [[current], [previous]] = await Promise.all([base(range.from, range.to), base(range.previousFrom, range.previousTo)]);

  const currentCost = toNumber(current?.cost);
  const previousCost = toNumber(previous?.cost);
  return {
    cost: { current: currentCost, previous: previousCost, changePercent: percentChange(currentCost, previousCost) },
    quantity: toNumber(current?.quantity),
    events: toNumber(current?.events),
    ingredientCount: toNumber(current?.ingredientCount),
  };
}

export type TrendPoint = { day: string; label: string; cost: number };

/**
 * Waste cost per bucket, zero-filled across the whole range.
 *
 * Grouping is by day, week or month depending on the span, so a year-long range
 * produces twelve points rather than 365. Buckets with no entries are filled
 * with zero so the line does not jump over quiet days.
 */
export async function getWasteTrendSeries(scope: Scope, range: DateRange, labelFor: (iso: string) => string): Promise<TrendPoint[]> {
  const conditions = [eq(wasteEntries.organizationId, scope.organizationId), gte(wasteEntries.occurredAt, range.from), lt(wasteEntries.occurredAt, range.to)];
  if (scope.locationId) conditions.push(eq(wasteEntries.locationId, scope.locationId));

  const unit = truncUnit(range.granularity);
  // The unit is inlined rather than bound. A bind parameter renders as a
  // *distinct* placeholder in the SELECT and in the GROUP BY, and Postgres
  // compares grouped expressions by parse tree — two Param nodes are never
  // equal, so it rejects the query with "must appear in the GROUP BY clause".
  // `truncUnit` returns one of day/week/month and never sees user input, so
  // there is nothing to inject here.
  const bucket = sql`date_trunc('${sql.raw(unit)}', ${wasteEntries.occurredAt} at time zone 'UTC')`;

  const rows = await getDb()
    .select({
      bucket: sql<string>`to_char(${bucket}, 'YYYY-MM-DD')`,
      cost: sql<string>`coalesce(sum(${wasteEntries.estimatedCostMillis}), 0)`,
    })
    .from(wasteEntries)
    .where(and(...conditions))
    .groupBy(bucket)
    .orderBy(bucket);

  const byBucket = new Map(rows.map(row => [row.bucket, toNumber(row.cost)]));
  return bucketStarts(range).map(iso => ({ day: iso, label: labelFor(iso), cost: byBucket.get(iso) ?? 0 }));
}

export type WasteReasonRow = { reason: string; cost: number; quantity: number; events: number; sharePercent: number };

/** Waste grouped by its recorded reason — the "why are we losing money" answer. */
export async function getWasteByReason(scope: Scope, range: DateRange): Promise<WasteReasonRow[]> {
  const conditions = [eq(wasteEntries.organizationId, scope.organizationId), gte(wasteEntries.occurredAt, range.from), lt(wasteEntries.occurredAt, range.to)];
  if (scope.locationId) conditions.push(eq(wasteEntries.locationId, scope.locationId));

  const rows = await getDb()
    .select({
      reason: wasteEntries.reason,
      cost: sql<string>`coalesce(sum(${wasteEntries.estimatedCostMillis}), 0)`,
      quantity: sql<string>`coalesce(sum(${wasteEntries.quantity}), 0)`,
      events: count(),
    })
    .from(wasteEntries)
    .where(and(...conditions))
    .groupBy(wasteEntries.reason)
    .orderBy(desc(sql`coalesce(sum(${wasteEntries.estimatedCostMillis}), 0)`));

  const total = rows.reduce((sumCost, row) => sumCost + toNumber(row.cost), 0);
  return rows.map(row => {
    const cost = toNumber(row.cost);
    return { reason: row.reason, cost, quantity: toNumber(row.quantity), events: toNumber(row.events), sharePercent: total > 0 ? (cost / total) * 100 : 0 };
  });
}

export type WasteIngredientRow = { ingredientId: string; ingredientName: string; unit: string; cost: number; quantity: number; events: number };

/** The ingredients losing the most money, worst first. */
export async function getWasteByIngredient(scope: Scope, range: DateRange, limit = 8): Promise<WasteIngredientRow[]> {
  const conditions = [eq(wasteEntries.organizationId, scope.organizationId), gte(wasteEntries.occurredAt, range.from), lt(wasteEntries.occurredAt, range.to)];
  if (scope.locationId) conditions.push(eq(wasteEntries.locationId, scope.locationId));

  const rows = await getDb()
    .select({
      ingredientId: wasteEntries.ingredientId,
      ingredientName: ingredients.name,
      unit: ingredients.baseUnitCode,
      cost: sql<string>`coalesce(sum(${wasteEntries.estimatedCostMillis}), 0)`,
      quantity: sql<string>`coalesce(sum(${wasteEntries.quantity}), 0)`,
      events: count(),
    })
    .from(wasteEntries)
    .innerJoin(ingredients, eq(ingredients.id, wasteEntries.ingredientId))
    .where(and(...conditions))
    .groupBy(wasteEntries.ingredientId, ingredients.name, ingredients.baseUnitCode)
    .orderBy(desc(sql`coalesce(sum(${wasteEntries.estimatedCostMillis}), 0)`))
    .limit(limit);

  return rows.map(row => ({ ...row, cost: toNumber(row.cost), quantity: toNumber(row.quantity), events: toNumber(row.events) }));
}

export type WasteLocationRow = { locationId: string; locationName: string; cost: number; events: number };

/** Waste split by location. Always org-wide — comparing sites is the point. */
export async function getWasteByLocation(scope: Pick<Scope, "organizationId">, range: DateRange): Promise<WasteLocationRow[]> {
  const rows = await getDb()
    .select({
      locationId: wasteEntries.locationId,
      locationName: locations.name,
      cost: sql<string>`coalesce(sum(${wasteEntries.estimatedCostMillis}), 0)`,
      events: count(),
    })
    .from(wasteEntries)
    .innerJoin(locations, eq(locations.id, wasteEntries.locationId))
    .where(and(eq(wasteEntries.organizationId, scope.organizationId), gte(wasteEntries.occurredAt, range.from), lt(wasteEntries.occurredAt, range.to)))
    .groupBy(wasteEntries.locationId, locations.name)
    .orderBy(desc(sql`coalesce(sum(${wasteEntries.estimatedCostMillis}), 0)`));

  return rows.map(row => ({ ...row, cost: toNumber(row.cost), events: toNumber(row.events) }));
}

export type RecentWasteRow = { id: string; ingredientName: string; unit: string; quantity: number; costMillis: number; reason: string; locationName: string; occurredAt: Date };

/** Newest waste entries, read from `waste_entries` so the reason is the real enum. */
export async function listRecentWaste(scope: Scope, range: DateRange, limit = 6): Promise<RecentWasteRow[]> {
  const conditions = [eq(wasteEntries.organizationId, scope.organizationId), gte(wasteEntries.occurredAt, range.from), lt(wasteEntries.occurredAt, range.to)];
  if (scope.locationId) conditions.push(eq(wasteEntries.locationId, scope.locationId));

  const rows = await getDb()
    .select({
      id: wasteEntries.id,
      ingredientName: ingredients.name,
      unit: ingredients.baseUnitCode,
      quantity: wasteEntries.quantity,
      costMillis: wasteEntries.estimatedCostMillis,
      reason: wasteEntries.reason,
      locationName: locations.name,
      occurredAt: wasteEntries.occurredAt,
    })
    .from(wasteEntries)
    .innerJoin(ingredients, eq(ingredients.id, wasteEntries.ingredientId))
    .innerJoin(locations, eq(locations.id, wasteEntries.locationId))
    .where(and(...conditions))
    .orderBy(desc(wasteEntries.occurredAt))
    .limit(limit);

  return rows.map(row => ({ ...row, quantity: toNumber(row.quantity) }));
}

// --------------------------------------------------------------------- inventory

export type InventoryValueRow = {
  id: string;
  name: string;
  category: string | null;
  unit: string;
  stock: number;
  minimum: number;
  unitCostMillis: number;
  valueMillis: number;
};

/**
 * Stock on hand valued at each ingredient's latest known unit cost.
 *
 * The balance is summed from the movement ledger inside SQL. Location scoping
 * happens in the join condition rather than the WHERE clause, so an ingredient
 * with no movements at the selected location still appears — at zero — instead
 * of vanishing from the valuation.
 */
export async function getInventoryValuation(scope: Scope): Promise<InventoryValueRow[]> {
  const movementJoin = scope.locationId
    ? and(eq(stockMovements.ingredientId, ingredients.id), eq(stockMovements.locationId, scope.locationId))
    : and(eq(stockMovements.ingredientId, ingredients.id), eq(stockMovements.organizationId, scope.organizationId));

  const rows = await getDb()
    .select({
      id: ingredients.id,
      name: ingredients.name,
      category: ingredients.category,
      unit: ingredients.baseUnitCode,
      minimum: ingredients.minimumStock,
      unitCostMillis: ingredients.latestUnitCostMillis,
      stock: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)`,
    })
    .from(ingredients)
    .leftJoin(stockMovements, movementJoin)
    .where(and(eq(ingredients.organizationId, scope.organizationId), eq(ingredients.isActive, true)))
    .groupBy(ingredients.id)
    .orderBy(asc(ingredients.name));

  return rows.map(row => {
    const stock = toNumber(row.stock);
    return {
      ...row,
      stock,
      minimum: toNumber(row.minimum),
      // Negative stock is a data problem, not negative value — floor at zero so
      // one bad count cannot understate the whole valuation.
      valueMillis: Math.round(Math.max(stock, 0) * row.unitCostMillis),
    };
  });
}

export type InventorySnapshot = {
  rows: InventoryValueRow[];
  totalValueMillis: number;
  activeCount: number;
  lowStock: InventoryValueRow[];
  outOfStock: InventoryValueRow[];
  topByValue: InventoryValueRow[];
};

/**
 * One valuation pass, reduced into the figures the dashboard needs.
 *
 * "Low stock" means at or below the ingredient's own `minimumStock`, which the
 * user set — no invented thresholds. An ingredient with no minimum recorded is
 * only ever flagged when it hits zero.
 */
export async function getInventorySnapshot(scope: Scope): Promise<InventorySnapshot> {
  const rows = await getInventoryValuation(scope);

  const outOfStock = rows.filter(row => row.stock <= 0);
  const lowStock = rows
    .filter(row => row.stock > 0 && row.minimum > 0 && row.stock <= row.minimum)
    .sort((a, b) => a.stock / a.minimum - b.stock / b.minimum);

  return {
    rows,
    totalValueMillis: rows.reduce((total, row) => total + row.valueMillis, 0),
    activeCount: rows.length,
    lowStock,
    outOfStock,
    topByValue: [...rows].filter(row => row.valueMillis > 0).sort((a, b) => b.valueMillis - a.valueMillis),
  };
}

export type CategoryValueRow = { category: string; valueMillis: number; ingredientCount: number };

/** Inventory value grouped by ingredient category, for the valuation report. */
export function getInventoryValueByCategory(rows: InventoryValueRow[]): CategoryValueRow[] {
  const grouped = new Map<string, CategoryValueRow>();
  for (const row of rows) {
    const key = row.category?.trim() || "Uncategorised";
    const existing = grouped.get(key);
    if (existing) {
      existing.valueMillis += row.valueMillis;
      existing.ingredientCount += 1;
    } else {
      grouped.set(key, { category: key, valueMillis: row.valueMillis, ingredientCount: 1 });
    }
  }
  return [...grouped.values()].sort((a, b) => b.valueMillis - a.valueMillis);
}

export type LocationValueRow = { locationId: string; locationName: string; valueMillis: number };

/** Stock value per location, valued at current ingredient costs. */
export async function getInventoryValueByLocation(organizationId: string): Promise<LocationValueRow[]> {
  const rows = await getDb()
    .select({
      locationId: locations.id,
      locationName: locations.name,
      valueMillis: sql<string>`coalesce(sum(greatest(${stockMovements.quantity}, 0) * ${ingredients.latestUnitCostMillis}), 0)`,
    })
    .from(locations)
    .leftJoin(stockMovements, eq(stockMovements.locationId, locations.id))
    .leftJoin(ingredients, eq(ingredients.id, stockMovements.ingredientId))
    .where(eq(locations.organizationId, organizationId))
    .groupBy(locations.id, locations.name)
    .orderBy(desc(sql`coalesce(sum(greatest(${stockMovements.quantity}, 0) * ${ingredients.latestUnitCostMillis}), 0)`));

  return rows.map(row => ({ ...row, valueMillis: Math.round(toNumber(row.valueMillis)) }));
}

// ---------------------------------------------------------------------- suppliers

export type PriceChangeRow = {
  ingredientId: string;
  ingredientName: string;
  baseUnitCode: string;
  supplierId: string | null;
  supplierName: string | null;
  currentPriceMillis: number;
  previousPriceMillis: number | null;
  changeMillis: number | null;
  changePercent: number | null;
  purchasedAt: Date;
};

/**
 * Most recent price paid per (supplier, ingredient) against the price before it.
 *
 * Both figures come from `purchase_items` — the invoices already recorded are
 * the price history, so nothing new is stored. Comparison is on
 * `base_unit_cost_millis` so a case bought one week and a kilo the next are
 * still comparable. A `lag()` window pairs each line with its predecessor, and
 * the outer filter keeps only the newest pair per pairing.
 */
export async function getSupplierPriceChanges(organizationId: string, limit = 100): Promise<PriceChangeRow[]> {
  const rows = await getDb().execute<{
    ingredient_id: string;
    ingredient_name: string;
    base_unit_code: string;
    supplier_id: string | null;
    supplier_name: string | null;
    current_price: string;
    previous_price: string | null;
    received_at: string;
  }>(sql`
    with priced as (
      select
        pi.ingredient_id,
        p.supplier_id,
        p.received_at,
        coalesce(pi.base_unit_cost_millis, pi.unit_cost_millis) as price,
        lag(coalesce(pi.base_unit_cost_millis, pi.unit_cost_millis)) over (
          partition by pi.ingredient_id, p.supplier_id order by p.received_at
        ) as previous_price,
        row_number() over (
          partition by pi.ingredient_id, p.supplier_id order by p.received_at desc
        ) as recency
      from ${purchaseItems} pi
      join ${purchases} p on p.id = pi.purchase_id
      where p.organization_id = ${organizationId}
        and p.status = 'received'
    )
    select
      priced.ingredient_id,
      i.name as ingredient_name,
      i.base_unit_code,
      priced.supplier_id,
      s.name as supplier_name,
      priced.price as current_price,
      priced.previous_price,
      priced.received_at
    from priced
    join ${ingredients} i on i.id = priced.ingredient_id
    left join ${suppliers} s on s.id = priced.supplier_id
    where priced.recency = 1 and priced.price > 0
    order by
      case when priced.previous_price is null or priced.previous_price = 0 then 0
           else abs(priced.price - priced.previous_price)::numeric / priced.previous_price end desc
    limit ${limit}
  `);

  return [...rows].map(row => {
    const current = toNumber(row.current_price);
    const previous = row.previous_price === null ? null : toNumber(row.previous_price);
    return {
      ingredientId: row.ingredient_id,
      ingredientName: row.ingredient_name,
      baseUnitCode: row.base_unit_code,
      supplierId: row.supplier_id,
      supplierName: row.supplier_name,
      currentPriceMillis: current,
      previousPriceMillis: previous,
      changeMillis: previous === null ? null : current - previous,
      changePercent: previous === null ? null : percentChange(current, previous),
      purchasedAt: new Date(row.received_at),
    };
  });
}

export type SupplierSpendRow = { supplierId: string; name: string; productCount: number; spendMillis: number; invoiceCount: number };

/** Spend per supplier in the period, with how many products each one lists. */
export async function getSupplierSpend(scope: Scope, range: DateRange): Promise<SupplierSpendRow[]> {
  const conditions = [eq(purchases.organizationId, scope.organizationId), eq(purchases.status, "received"), gte(purchases.receivedAt, range.from), lt(purchases.receivedAt, range.to)];
  if (scope.locationId) conditions.push(eq(purchases.locationId, scope.locationId));

  const rows = await getDb()
    .select({
      supplierId: suppliers.id,
      name: suppliers.name,
      spendMillis: sql<string>`coalesce(sum(${purchases.totalMillis}), 0)`,
      invoiceCount: count(),
      productCount: sql<string>`(select count(*) from supplier_products sp where sp.supplier_id = "suppliers"."id" and sp.is_active = true)`,
    })
    .from(purchases)
    .innerJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .where(and(...conditions))
    .groupBy(suppliers.id, suppliers.name)
    .orderBy(desc(sql`coalesce(sum(${purchases.totalMillis}), 0)`));

  return rows.map(row => ({ ...row, spendMillis: toNumber(row.spendMillis), invoiceCount: toNumber(row.invoiceCount), productCount: toNumber(row.productCount) }));
}

// ---------------------------------------------------------------------- purchases

export type RecentPurchaseRow = { id: string; invoiceNumber: string | null; supplierName: string | null; locationName: string; totalMillis: number; receivedAt: Date; itemCount: number };

/** Newest received invoices in the period. */
export async function listRecentPurchases(scope: Scope, range: DateRange, limit = 6): Promise<RecentPurchaseRow[]> {
  const conditions = [eq(purchases.organizationId, scope.organizationId), eq(purchases.status, "received"), gte(purchases.receivedAt, range.from), lt(purchases.receivedAt, range.to)];
  if (scope.locationId) conditions.push(eq(purchases.locationId, scope.locationId));

  const db = getDb();
  const rows = await db
    .select({
      id: purchases.id,
      invoiceNumber: purchases.invoiceNumber,
      supplierName: suppliers.name,
      locationName: locations.name,
      totalMillis: purchases.totalMillis,
      receivedAt: purchases.receivedAt,
      itemCount: db.$count(purchaseItems, eq(purchaseItems.purchaseId, purchases.id)),
    })
    .from(purchases)
    .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .innerJoin(locations, eq(locations.id, purchases.locationId))
    .where(and(...conditions))
    .orderBy(desc(purchases.receivedAt))
    .limit(limit);

  return rows.map(row => ({ ...row, itemCount: toNumber(row.itemCount) }));
}

export type MovementRow = {
  id: string;
  type: string;
  quantity: number;
  unitCostMillis: number;
  ingredientName: string;
  unit: string;
  locationName: string;
  occurredAt: Date;
};

/** Recent ledger entries in the period — the audit trail behind every balance. */
export async function listRecentMovements(scope: Scope, range: DateRange, limit = 8): Promise<MovementRow[]> {
  const conditions = [eq(stockMovements.organizationId, scope.organizationId), gte(stockMovements.occurredAt, range.from), lt(stockMovements.occurredAt, range.to)];
  if (scope.locationId) conditions.push(eq(stockMovements.locationId, scope.locationId));

  const rows = await getDb()
    .select({
      id: stockMovements.id,
      type: stockMovements.type,
      quantity: stockMovements.quantity,
      unitCostMillis: stockMovements.unitCostMillis,
      ingredientName: ingredients.name,
      unit: ingredients.baseUnitCode,
      locationName: locations.name,
      occurredAt: stockMovements.occurredAt,
    })
    .from(stockMovements)
    .innerJoin(ingredients, eq(ingredients.id, stockMovements.ingredientId))
    .innerJoin(locations, eq(locations.id, stockMovements.locationId))
    .where(and(...conditions))
    .orderBy(desc(stockMovements.occurredAt))
    .limit(limit);

  return rows.map(row => ({ ...row, quantity: toNumber(row.quantity) }));
}
