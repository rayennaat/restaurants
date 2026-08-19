import { and, asc, count, desc, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, locations, menuItems, saleLines, sales } from "@/db/schema";
import { bucketStarts, percentChange, type DateRange, type Granularity } from "@/lib/date-range";
import {
  calculateTheoreticalConsumption,
  countUnmappedSales,
  expandMenuItemConsumption,
  type ConsumedIngredient,
} from "@/lib/consumption";
import type { MenuGraphNode } from "@/lib/costing";
import type { UnitRow } from "@/lib/units";
import type { PeriodMetric, Scope } from "@/server/queries/analytics";
import { listMenuItems } from "@/server/queries/menu";
import { getPreparationGraph } from "@/server/queries/recipes";

/**
 * Sales reporting.
 *
 * Aggregated in PostgreSQL for the same reason as the rest of analytics — a
 * busy restaurant produces far too many lines to reduce in React.
 *
 * Two invariants run through every query here:
 *
 * **Revenue comes from `sale_lines.unit_price_millis`**, the price snapshotted
 * when the sale was recorded — never from `menu_items.selling_price_millis`.
 * Joining to `menu_items` for a *name* is fine; joining for a *price* would
 * silently rewrite last month's revenue the next time someone edits the menu.
 *
 * **Voided sales are excluded**, always, via `status = 'recorded'`. A void is a
 * flag rather than a delete, so the filter is what makes it take effect.
 */

const RECORDED = eq(sales.status, "recorded");

const toNumber = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const truncUnit = (granularity: Granularity) => (granularity === "month" ? "month" : granularity === "week" ? "week" : "day");

/** Scope + period filter shared by every aggregate below. */
function scopeConditions(scope: Scope, from: Date, to: Date) {
  const conditions = [eq(sales.organizationId, scope.organizationId), RECORDED, gte(sales.soldAt, from), lt(sales.soldAt, to)];
  if (scope.locationId) conditions.push(eq(sales.locationId, scope.locationId));
  return conditions;
}

export type SalesSummary = {
  revenue: PeriodMetric;
  /** Number of sales records, not covers — a ticket and a daily aggregate both count as one. */
  transactions: PeriodMetric;
  unitsSold: PeriodMetric;
  /** Revenue ÷ units sold, in minor units. Zero when nothing sold. */
  averageUnitPriceMillis: number;
  /** Revenue ÷ transactions, in minor units. Zero when nothing sold. */
  averageTransactionMillis: number;
  distinctMenuItems: number;
};

/**
 * Headline figures for the period, each against the preceding equal-length one.
 *
 * Revenue is summed from `sales.total_millis` rather than by re-adding the
 * lines: the total was computed from the snapshotted prices at write time and
 * the lines are frozen, so the two agree by construction and the header total
 * costs one index scan instead of a join.
 */
export async function getSalesSummary(scope: Scope, range: DateRange): Promise<SalesSummary> {
  const headline = (from: Date, to: Date) =>
    getDb()
      .select({
        revenue: sql<string>`coalesce(sum(${sales.totalMillis}), 0)`,
        transactions: count(),
      })
      .from(sales)
      .where(and(...scopeConditions(scope, from, to)));

  // Units and distinct dishes need the lines; an inner join drops nothing
  // because a sale cannot be recorded without at least one line.
  const lineAggregate = (from: Date, to: Date) =>
    getDb()
      .select({
        units: sql<string>`coalesce(sum(${saleLines.quantity}), 0)`,
        distinctItems: sql<string>`count(distinct ${saleLines.menuItemId})`,
      })
      .from(saleLines)
      .innerJoin(sales, eq(saleLines.saleId, sales.id))
      .where(and(...scopeConditions(scope, from, to)));

  const [[current], [previous], [currentLines], [previousLines]] = await Promise.all([
    headline(range.from, range.to),
    headline(range.previousFrom, range.previousTo),
    lineAggregate(range.from, range.to),
    lineAggregate(range.previousFrom, range.previousTo),
  ]);

  const revenue = toNumber(current?.revenue);
  const previousRevenue = toNumber(previous?.revenue);
  const transactions = toNumber(current?.transactions);
  const previousTransactions = toNumber(previous?.transactions);
  const unitsSold = toNumber(currentLines?.units);
  const previousUnits = toNumber(previousLines?.units);

  return {
    revenue: { current: revenue, previous: previousRevenue, changePercent: percentChange(revenue, previousRevenue) },
    transactions: {
      current: transactions,
      previous: previousTransactions,
      changePercent: percentChange(transactions, previousTransactions),
    },
    unitsSold: { current: unitsSold, previous: previousUnits, changePercent: percentChange(unitsSold, previousUnits) },
    averageUnitPriceMillis: unitsSold > 0 ? Math.round(revenue / unitsSold) : 0,
    averageTransactionMillis: transactions > 0 ? Math.round(revenue / transactions) : 0,
    distinctMenuItems: toNumber(currentLines?.distinctItems),
  };
}

/** Today's sales, in the organization's own timezone rather than UTC. */
export async function getTodaySales(scope: Scope, timeZone: string) {
  const [row] = await getDb()
    .select({
      revenue: sql<string>`coalesce(sum(${sales.totalMillis}), 0)`,
      transactions: count(),
    })
    .from(sales)
    .where(
      and(
        eq(sales.organizationId, scope.organizationId),
        RECORDED,
        // Compared as a local calendar date: a 23:30 sale belongs to today for
        // the restaurant even when UTC has already rolled over.
        sql`(${sales.soldAt} at time zone ${timeZone})::date = (now() at time zone ${timeZone})::date`,
        ...(scope.locationId ? [eq(sales.locationId, scope.locationId)] : []),
      ),
    );

  return { revenueMillis: toNumber(row?.revenue), transactions: toNumber(row?.transactions) };
}

export type MenuItemSales = {
  menuItemId: string;
  /** The name as sold, snapshotted on the line — a later rename does not rewrite history. */
  menuItemName: string;
  quantity: number;
  revenueMillis: number;
  /** Revenue ÷ quantity, so a price change mid-period shows as a blended figure. */
  averagePriceMillis: number;
  transactions: number;
};

/**
 * Sales per dish, best-selling first.
 *
 * Grouped by the snapshotted `menuItemName`, not by a join to the live catalog,
 * so a dish that was renamed or deleted still reports under the name it sold as.
 */
export async function getSalesByMenuItem(scope: Scope, range: DateRange, limit?: number): Promise<MenuItemSales[]> {
  const query = getDb()
    .select({
      menuItemId: saleLines.menuItemId,
      menuItemName: saleLines.menuItemName,
      quantity: sql<string>`coalesce(sum(${saleLines.quantity}), 0)`,
      revenue: sql<string>`coalesce(sum(${saleLines.lineTotalMillis}), 0)`,
      transactions: sql<string>`count(distinct ${saleLines.saleId})`,
    })
    .from(saleLines)
    .innerJoin(sales, eq(saleLines.saleId, sales.id))
    .where(and(...scopeConditions(scope, range.from, range.to)))
    .groupBy(saleLines.menuItemId, saleLines.menuItemName)
    .orderBy(desc(sql`sum(${saleLines.lineTotalMillis})`));

  const rows = await (limit ? query.limit(limit) : query);

  return rows.map(row => {
    const quantity = toNumber(row.quantity);
    const revenueMillis = toNumber(row.revenue);
    return {
      menuItemId: row.menuItemId,
      menuItemName: row.menuItemName,
      quantity,
      revenueMillis,
      averagePriceMillis: quantity > 0 ? Math.round(revenueMillis / quantity) : 0,
      transactions: toNumber(row.transactions),
    };
  });
}

export type SalesTrendPoint = { day: string; label: string; revenueMillis: number; transactions: number };

/**
 * Revenue per bucket, zero-filled across the range.
 *
 * The bucket expression is inlined rather than bound as a parameter. Postgres
 * compares GROUP BY expressions by parse tree, and two `$n` placeholders are
 * never equal even when they carry the same value — so a parameterised
 * `date_trunc` unit makes the server reject the query. `truncUnit` returns one
 * of three literals and never sees user input.
 */
export async function getSalesTrend(scope: Scope, range: DateRange, labelFor: (iso: string) => string): Promise<SalesTrendPoint[]> {
  const unit = truncUnit(range.granularity);
  const bucket = sql`date_trunc('${sql.raw(unit)}', ${sales.soldAt} at time zone 'UTC')`;

  const rows = await getDb()
    .select({
      bucket: sql<string>`to_char(${bucket}, 'YYYY-MM-DD')`,
      revenue: sql<string>`coalesce(sum(${sales.totalMillis}), 0)`,
      transactions: count(),
    })
    .from(sales)
    .where(and(...scopeConditions(scope, range.from, range.to)))
    .groupBy(bucket)
    .orderBy(bucket);

  const byBucket = new Map(rows.map(row => [row.bucket, row]));
  return bucketStarts(range).map(iso => {
    const row = byBucket.get(iso);
    return {
      day: iso,
      label: labelFor(iso),
      revenueMillis: toNumber(row?.revenue),
      transactions: toNumber(row?.transactions),
    };
  });
}

export type LocationSales = { locationId: string; locationName: string; revenueMillis: number; transactions: number; unitsSold: number };

/**
 * Revenue per location. Always organization-wide — comparing sites is the point,
 * so this ignores `scope.locationId`.
 */
export async function getSalesByLocation(scope: Pick<Scope, "organizationId">, range: DateRange): Promise<LocationSales[]> {
  const db = getDb();
  const conditions = [eq(sales.organizationId, scope.organizationId), RECORDED, gte(sales.soldAt, range.from), lt(sales.soldAt, range.to)];

  // Keep sale totals and line quantities in separate aggregates. Joining both
  // tables directly would multiply a sale total once per line, while correlating
  // the line aggregate to the grouped sales query triggers PostgreSQL grouping
  // rules on the outer tenant column.
  const [revenueRows, unitRows] = await Promise.all([
    db
      .select({
        locationId: sales.locationId,
        locationName: locations.name,
        revenue: sql<string>`coalesce(sum(${sales.totalMillis}), 0)`,
        transactions: count(),
      })
      .from(sales)
      .innerJoin(locations, eq(locations.id, sales.locationId))
      .where(and(...conditions))
      .groupBy(sales.locationId, locations.name)
      .orderBy(desc(sql`sum(${sales.totalMillis})`)),
    db
      .select({
        locationId: sales.locationId,
        units: sql<string>`coalesce(sum(${saleLines.quantity}), 0)`,
      })
      .from(sales)
      .innerJoin(saleLines, eq(saleLines.saleId, sales.id))
      .where(and(...conditions))
      .groupBy(sales.locationId),
  ]);

  const unitsByLocation = new Map(unitRows.map(row => [row.locationId, toNumber(row.units)]));
  return revenueRows.map(row => ({
    locationId: row.locationId,
    locationName: row.locationName,
    revenueMillis: toNumber(row.revenue),
    transactions: toNumber(row.transactions),
    unitsSold: unitsByLocation.get(row.locationId) ?? 0,
  }));
}

export type SaleListRow = {
  id: string;
  reference: string | null;
  source: string;
  status: string;
  locationName: string;
  soldAt: Date;
  totalMillis: number;
  lineCount: number;
};

/**
 * Recent sales for the list screen.
 *
 * Includes voided sales — this is the ledger view, where a void must stay
 * visible and explicable rather than vanishing. Every *revenue* aggregate above
 * excludes them.
 */
export async function listSales(scope: Scope, range: DateRange, limit = 100): Promise<SaleListRow[]> {
  const conditions = [eq(sales.organizationId, scope.organizationId), gte(sales.soldAt, range.from), lt(sales.soldAt, range.to)];
  if (scope.locationId) conditions.push(eq(sales.locationId, scope.locationId));

  const db = getDb();
  const rows = await db
    .select({
      id: sales.id,
      reference: sales.reference,
      source: sales.source,
      status: sales.status,
      locationName: locations.name,
      soldAt: sales.soldAt,
      totalMillis: sales.totalMillis,
      lineCount: db.$count(saleLines, eq(saleLines.saleId, sales.id)),
    })
    .from(sales)
    .innerJoin(locations, eq(locations.id, sales.locationId))
    .where(and(...conditions))
    .orderBy(desc(sales.soldAt))
    .limit(limit);

  return rows.map(row => ({ ...row, lineCount: toNumber(row.lineCount) }));
}

export type SaleDetail = {
  id: string;
  reference: string | null;
  source: string;
  status: string;
  externalId: string | null;
  note: string | null;
  locationId: string;
  locationName: string;
  soldAt: Date;
  totalMillis: number;
  voidReason: string | null;
  voidedAt: Date | null;
  lines: {
    id: string;
    menuItemId: string;
    menuItemName: string;
    quantity: number;
    unitPriceMillis: number;
    lineTotalMillis: number;
    /** Current menu price, for comparison only — never used to value the sale. */
    currentPriceMillis: number | null;
  }[];
};

/**
 * One sale with its lines, scoped by organization in the WHERE clause so an id
 * from another tenant resolves to nothing rather than leaking its existence.
 *
 * `currentPriceMillis` is joined purely so the detail screen can show that a
 * dish has been re-priced since. The sale is always valued by its own
 * snapshotted `unitPriceMillis`.
 */
export async function getSale(organizationId: string, saleId: string): Promise<SaleDetail | null> {
  const db = getDb();

  const [sale] = await db
    .select({
      id: sales.id,
      reference: sales.reference,
      source: sales.source,
      status: sales.status,
      externalId: sales.externalId,
      note: sales.note,
      locationId: sales.locationId,
      locationName: locations.name,
      soldAt: sales.soldAt,
      totalMillis: sales.totalMillis,
      voidReason: sales.voidReason,
      voidedAt: sales.voidedAt,
    })
    .from(sales)
    .innerJoin(locations, eq(locations.id, sales.locationId))
    .where(and(eq(sales.id, saleId), eq(sales.organizationId, organizationId)))
    .limit(1);

  if (!sale) return null;

  const lines = await db
    .select({
      id: saleLines.id,
      menuItemId: saleLines.menuItemId,
      menuItemName: saleLines.menuItemName,
      quantity: saleLines.quantity,
      unitPriceMillis: saleLines.unitPriceMillis,
      lineTotalMillis: saleLines.lineTotalMillis,
      currentPriceMillis: menuItems.sellingPriceMillis,
    })
    .from(saleLines)
    .leftJoin(menuItems, eq(menuItems.id, saleLines.menuItemId))
    .where(eq(saleLines.saleId, saleId))
    .orderBy(asc(saleLines.sortOrder));

  return {
    ...sale,
    lines: lines.map(line => ({ ...line, quantity: toNumber(line.quantity) })),
  };
}

/**
 * Units sold per menu item — the input the theoretical consumption engine needs.
 *
 * Returns ids and quantities only; expanding them into ingredients is
 * `expandMenuItemConsumption` + `calculateTheoreticalConsumption` in
 * `lib/consumption`, which is pure and separately tested.
 */
export async function getSoldQuantities(scope: Scope, range: DateRange): Promise<{ menuItemId: string; quantity: number }[]> {
  const rows = await getDb()
    .select({
      menuItemId: saleLines.menuItemId,
      quantity: sql<string>`coalesce(sum(${saleLines.quantity}), 0)`,
    })
    .from(saleLines)
    .innerJoin(sales, eq(saleLines.saleId, sales.id))
    .where(and(...scopeConditions(scope, range.from, range.to)))
    .groupBy(saleLines.menuItemId);

  return rows.map(row => ({ menuItemId: row.menuItemId, quantity: toNumber(row.quantity) }));
}

/** Whether the workspace has any sales at all, for choosing an empty state. */
export async function hasAnySales(organizationId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: sales.id })
    .from(sales)
    .where(eq(sales.organizationId, organizationId))
    .limit(1);
  return Boolean(row);
}

export type TheoreticalConsumptionReport = {
  rows: ConsumedIngredient[];
  totalCostMillis: number;
  /** Sold units belonging to dishes with no usable composition. */
  unmappedUnits: number;
  unmappedMenuItemIds: string[];
};

/**
 * What the kitchen *should* have used, given what sold in the period.
 *
 * Composed rather than reimplemented: units sold come from
 * {@link getSoldQuantities}, the dish→ingredient expansion is the pure
 * `lib/consumption` engine, and the recipe graph is the same one that prices
 * the menu. So a change to a recipe immediately changes the theoretical figure,
 * and there is no second definition of "what a burger contains" to drift.
 *
 * `unmappedUnits` is reported alongside because a dish with no composition
 * contributes nothing: without it, an implausibly low figure reads as low usage
 * rather than as missing recipe data.
 */
export async function getTheoreticalConsumption(
  organizationId: string,
  scope: Scope,
  range: DateRange,
  units: UnitRow[],
): Promise<TheoreticalConsumptionReport> {
  const [sold, menuRows, preparations] = await Promise.all([
    getSoldQuantities(scope, range),
    // Every dish, including archived ones: a sale from before a dish was
    // retired still consumed its ingredients.
    listMenuItems(organizationId, units, { status: "all" }),
    getPreparationGraph(organizationId),
  ]);

  if (!sold.length) return { rows: [], totalCostMillis: 0, unmappedUnits: 0, unmappedMenuItemIds: [] };

  // Current ingredient costs, so consumption is valued at today's replacement
  // cost. `listMenuItems` returns display lines that carry no unit cost, so the
  // costs are fetched here rather than left at zero — which would silently
  // report every ingredient as free.
  const costRows = await getDb()
    .select({ id: ingredients.id, unitCostMillis: ingredients.latestUnitCostMillis })
    .from(ingredients)
    .where(eq(ingredients.organizationId, organizationId));
  const costById = new Map(costRows.map(row => [row.id, row.unitCostMillis]));

  const menuNodes: MenuGraphNode[] = menuRows.map(row => ({
    id: row.id,
    name: row.name,
    yieldQuantity: row.yieldQuantity,
    lines: row.lines.map(line =>
      line.kind === "recipe"
        ? { kind: "recipe" as const, componentRecipeId: line.targetId, componentName: line.name, quantity: line.quantity, unitCode: line.unitCode }
        : {
            kind: "ingredient" as const,
            ingredientId: line.targetId,
            ingredientName: line.name,
            quantity: line.quantity,
            unitCode: line.unitCode,
            baseUnitCode: line.baseUnitCode,
            unitCostMillis: costById.get(line.targetId) ?? 0,
          },
    ),
  }));

  const requirements = expandMenuItemConsumption(menuNodes, preparations, units);
  const rows = calculateTheoreticalConsumption(sold, requirements);
  const unmapped = countUnmappedSales(sold, requirements);

  return {
    rows,
    totalCostMillis: rows.reduce((total, row) => total + row.costMillis, 0),
    unmappedUnits: unmapped.units,
    unmappedMenuItemIds: unmapped.menuItemIds,
  };
}
