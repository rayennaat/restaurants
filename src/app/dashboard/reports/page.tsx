import { Coins, PackageSearch, Receipt, ReceiptText, Trash2, TrendingUp, UtensilsCrossed } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { AnalyticsFilters } from "@/components/dashboard/analytics-filters";
import { WasteChart } from "@/components/charts/waste-chart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { TabNav } from "@/components/ui/tab-nav";
import { foodCostTone } from "@/lib/costing";
import { bucketLabel, type DateRange } from "@/lib/date-range";
import { formatMoney, formatPercent } from "@/lib/money";
import { formatQuantity } from "@/lib/units";
import { cn } from "@/lib/utils";
import { wasteReasonLabel } from "@/lib/waste-reasons";
import { getAnalyticsContext, type AnalyticsSearchParams } from "@/server/analytics-context";
import {
  getInventorySnapshot,
  getInventoryValueByCategory,
  getInventoryValueByLocation,
  getSupplierPriceChanges,
  getSupplierSpend,
  getWasteByIngredient,
  getWasteByLocation,
  getWasteByReason,
  getWasteSummary,
  getWasteTrendSeries,
  listRecentMovements,
  type Scope,
} from "@/server/queries/analytics";
import { listMenuItems } from "@/server/queries/menu";
import {
  getSalesByLocation,
  getSalesByMenuItem,
  getSalesSummary,
  getSalesTrend,
  getTheoreticalConsumption,
} from "@/server/queries/sales";
import { getSupplierComparison } from "@/server/queries/suppliers";
import { getOrganizationUnits } from "@/server/tenant";

export const metadata = { title: "Reports" };

const REPORTS = [
  { key: "sales", label: "Sales", blurb: "Revenue, best sellers and the stock those sales should have used" },
  { key: "waste", label: "Waste", blurb: "What you threw away, what it cost and what caused it" },
  { key: "inventory", label: "Inventory valuation", blurb: "What you hold, what it is worth and what needs reordering" },
  { key: "suppliers", label: "Supplier prices", blurb: "What each supplier charges you, and where prices are moving" },
  { key: "menu", label: "Menu profitability", blurb: "What each dish costs, earns and returns as margin" },
] as const;

type ReportKey = (typeof REPORTS)[number]["key"];

export default async function ReportsPage({ searchParams }: { searchParams: Promise<AnalyticsSearchParams> }) {
  const params = await searchParams;
  const { tenant, range, location, scope, fromInput, toInput } = await getAnalyticsContext(params);

  const requested = Array.isArray(params.report) ? params.report[0] : params.report;
  const active: ReportKey = REPORTS.some(report => report.key === requested) ? (requested as ReportKey) : "waste";

  // Switching report keeps the active period and location.
  const tabHref = (key: ReportKey) => {
    const next = new URLSearchParams();
    if (range.preset !== "last_30_days") next.set("range", range.preset);
    if (range.preset === "custom") {
      next.set("from", fromInput);
      next.set("to", toInput);
    }
    if (location.id) next.set("location", location.id);
    if (key !== "waste") next.set("report", key);
    const query = next.toString();
    return query ? `/dashboard/reports?${query}` : "/dashboard/reports";
  };

  const periodHint = `${range.label} · ${location.name}`;
  const multiLocation = location.options.length > 1;
  const activeReport = REPORTS.find(report => report.key === active)!;

  return (
    <>
      <PageHeader
        eyebrow="Business"
        title="Reports"
        description="Detailed breakdowns of sales, waste, inventory value, supplier pricing and menu profitability — every figure calculated from this workspace's own records."
      />

      <AnalyticsFilters locations={location.options} currentPreset={range.preset} currentLocationId={location.id} from={fromInput} to={toInput} className="mb-4" />

      <TabNav
        label="Report"
        className="mb-4"
        items={REPORTS.map(report => ({ label: report.label, href: tabHref(report.key), current: active === report.key }))}
      />

      <div className="mb-5 rounded-lg border bg-white px-4 py-3 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Current report</p>
        <h2 className="mt-1 text-base font-black text-[var(--foreground)]">{activeReport.label}</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">{activeReport.blurb}</p>
      </div>

      {active === "sales" && (
        <SalesReport scope={scope} range={range} organizationId={tenant.organizationId} currency={tenant.currency} periodHint={periodHint} multiLocation={multiLocation} />
      )}
      {active === "waste" && <WasteReport scope={scope} range={range} currency={tenant.currency} periodHint={periodHint} multiLocation={multiLocation} />}
      {active === "inventory" && (
        <InventoryReport scope={scope} range={range} organizationId={tenant.organizationId} currency={tenant.currency} locationName={location.name} multiLocation={multiLocation} />
      )}
      {active === "suppliers" && <SupplierPriceReport scope={scope} range={range} currency={tenant.currency} />}
      {active === "menu" && <MenuProfitabilityReport organizationId={tenant.organizationId} currency={tenant.currency} />}
    </>
  );
}

/** Compact figure tile used at the head of each report. */
function SummaryTile({ label, value, hint, tone = "neutral" }: { label: string; value: string; hint: string; tone?: "neutral" | "success" | "danger" }) {
  return (
    <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
        <p className="text-sm font-semibold text-[var(--muted)]">{label}</p>
        <p className={cn("mt-1.5 text-2xl font-black tabular-nums", tone === "success" && "text-green-800", tone === "danger" && "text-red-700")}>{value}</p>
        <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>
      </div>
  );
}

/* ------------------------------------------------------------------ sales report */

/**
 * Sales, and the ingredient usage those sales imply.
 *
 * Revenue here is always the snapshotted price on each sale line, never the
 * current menu price — re-pricing a dish must not rewrite last month's takings.
 *
 * The consumption table is *theoretical*: what the recipes say those sales
 * should have used. It is deliberately not reconciled against the stock ledger
 * on this screen — that comparison belongs to a stock count, where a real
 * counted quantity exists to compare against.
 */
async function SalesReport({
  scope,
  range,
  organizationId,
  currency,
  periodHint,
  multiLocation,
}: {
  scope: Scope;
  range: DateRange;
  organizationId: string;
  currency: string;
  periodHint: string;
  multiLocation: boolean;
}) {
  const units = await getOrganizationUnits(organizationId);
  const [summary, byMenuItem, trend, byLocation, consumption] = await Promise.all([
    getSalesSummary(scope, range),
    getSalesByMenuItem(scope, range, 25),
    getSalesTrend(scope, range, iso => bucketLabel(iso, range.granularity)),
    multiLocation ? getSalesByLocation(scope, range) : Promise.resolve([]),
    getTheoreticalConsumption(organizationId, scope, range, units),
  ]);

  if (summary.transactions.current === 0) {
    return (
      <Card>
        <EmptyState
          icon={Receipt}
          title="No sales in this period"
          description="Record sales to measure revenue, track your best sellers and see how much stock your menu should be consuming."
          action={{ label: "Open sales", href: "/dashboard/sales" }}
        />
      </Card>
    );
  }

  const peak = Math.max(...trend.map(point => point.revenueMillis), 0);
  const revenueChange = summary.revenue.changePercent;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-4">
        <SummaryTile label="Revenue" value={formatMoney(summary.revenue.current, currency)} hint={periodHint} tone="success" />
        <SummaryTile
          label="Transactions"
          value={summary.transactions.current.toLocaleString()}
          hint={`${formatMoney(summary.averageTransactionMillis, currency)} average`}
        />
        <SummaryTile
          label="Units sold"
          value={summary.unitsSold.current.toLocaleString()}
          hint={`Across ${summary.distinctMenuItems} menu item${summary.distinctMenuItems === 1 ? "" : "s"}`}
        />
        <SummaryTile
          label="vs previous period"
          value={revenueChange === null ? "—" : `${revenueChange > 0 ? "+" : ""}${formatPercent(revenueChange)}`}
          hint={revenueChange === null ? "No comparable history" : `${formatMoney(summary.revenue.previous, currency)} before`}
          tone={revenueChange !== null && revenueChange < 0 ? "danger" : "success"}
        />
      </div>

      <Card>
        <CardHeader className="border-b">
          <h3 className="font-black">Revenue trend</h3>
          <p className="text-sm text-[var(--muted)]">
            {range.granularity === "day" ? "Daily" : range.granularity === "week" ? "Weekly" : "Monthly"} totals · {periodHint}
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {trend.map(point => (
            <div key={point.day} className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-xs text-[var(--muted)]">{point.label}</span>
              <span className="h-2.5 flex-1 overflow-hidden rounded-full bg-neutral-100">
                <span
                  className="block h-full rounded-full bg-green-700"
                  // Scaled against the period's own peak so the shape stays
                  // readable whether the busiest day took 200 DT or 20,000.
                  style={{ width: peak > 0 ? `${Math.max((point.revenueMillis / peak) * 100, point.revenueMillis > 0 ? 2 : 0)}%` : "0%" }}
                />
              </span>
              <span className="w-28 shrink-0 text-right text-sm tabular-nums">{formatMoney(point.revenueMillis, currency)}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <h3 className="font-black">Sales by menu item</h3>
          <p className="text-sm text-[var(--muted)]">
            Ranked by revenue. Average price is revenue ÷ units, so a mid-period price change shows as a blended figure.
          </p>
        </CardHeader>
        <Table className="min-w-[720px]">
          <THead>
            <TR className="hover:bg-transparent">
              <TH className="w-12">#</TH>
              <TH>Menu item</TH>
              <TH className="text-right">Units</TH>
              <TH className="text-right">Transactions</TH>
              <TH className="text-right">Avg price</TH>
              <TH className="text-right">Revenue</TH>
              <TH className="text-right">Share</TH>
            </TR>
          </THead>
          <TBody>
            {byMenuItem.map((row, index) => (
              <TR key={row.menuItemId}>
                <TD className="text-sm font-black text-[var(--muted)]">{index + 1}</TD>
                <TD>
                  <b className="text-sm">{row.menuItemName}</b>
                </TD>
                <TDNum>{row.quantity.toLocaleString()}</TDNum>
                <TDNum>{row.transactions.toLocaleString()}</TDNum>
                <TDNum className="text-[var(--muted)]">{formatMoney(row.averagePriceMillis, currency)}</TDNum>
                <TDNum className="font-semibold">{formatMoney(row.revenueMillis, currency)}</TDNum>
                <TDNum>{summary.revenue.current > 0 ? formatPercent((row.revenueMillis / summary.revenue.current) * 100, 0) : "—"}</TDNum>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>

      {multiLocation && byLocation.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader>
            <h3 className="font-black">Sales by location</h3>
            <p className="text-sm text-[var(--muted)]">Every location in the organization · {range.label}</p>
          </CardHeader>
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Location</TH>
                <TH className="text-right">Transactions</TH>
                <TH className="text-right">Units</TH>
                <TH className="text-right">Revenue</TH>
              </TR>
            </THead>
            <TBody>
              {byLocation.map(row => (
                <TR key={row.locationId}>
                  <TD>
                    <b className="text-sm">{row.locationName}</b>
                  </TD>
                  <TDNum>{row.transactions.toLocaleString()}</TDNum>
                  <TDNum>{row.unitsSold.toLocaleString()}</TDNum>
                  <TDNum className="font-semibold">{formatMoney(row.revenueMillis, currency)}</TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <h3 className="font-black">Theoretical ingredient consumption</h3>
          <p className="text-sm text-[var(--muted)]">
            What these sales should have used, expanded through your recipes and any preparations inside them. Valued at current
            ingredient costs. This is not a stock movement — compare it against a stock count to find variance.
          </p>
        </CardHeader>

        {consumption.rows.length === 0 ? (
          <EmptyState
            icon={UtensilsCrossed}
            title="Nothing to expand yet"
            description="The dishes sold in this period have no ingredients attached, so their consumption cannot be derived. Add compositions to your menu items."
            action={{ label: "Open menu", href: "/dashboard/menu" }}
            className="py-8"
          />
        ) : (
          <>
            {consumption.unmappedUnits > 0 && (
              <CardContent className="pt-0">
                <p className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900">
                  <b>{consumption.unmappedUnits.toLocaleString()} sold unit{consumption.unmappedUnits === 1 ? "" : "s"}</b> came from{" "}
                  {consumption.unmappedMenuItemIds.length} dish{consumption.unmappedMenuItemIds.length === 1 ? "" : "es"} with no
                  composition, so they add nothing below. The real consumption is higher than shown.
                </p>
              </CardContent>
            )}
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Ingredient</TH>
                  <TH className="text-right">Theoretical usage</TH>
                  <TH className="text-right">Value</TH>
                  <TH className="text-right">Share</TH>
                </TR>
              </THead>
              <TBody>
                {consumption.rows.map(row => (
                  <TR key={row.ingredientId}>
                    <TD>
                      <b className="text-sm">{row.ingredientName}</b>
                    </TD>
                    <TDNum>{formatQuantity(row.quantity, row.baseUnitCode)}</TDNum>
                    <TDNum className="font-semibold">{formatMoney(row.costMillis, currency)}</TDNum>
                    <TDNum>
                      {consumption.totalCostMillis > 0 ? formatPercent((row.costMillis / consumption.totalCostMillis) * 100, 0) : "—"}
                    </TDNum>
                  </TR>
                ))}
              </TBody>
            </Table>
            <CardContent className="pt-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-t pt-4">
                <span className="text-sm font-semibold text-[var(--muted)]">Theoretical food cost</span>
                <span className="text-lg font-black tabular-nums">{formatMoney(consumption.totalCostMillis, currency)}</span>
              </div>
              {summary.revenue.current > 0 && (
                <p className="mt-1 text-right text-xs text-[var(--muted)]">
                  {formatPercent((consumption.totalCostMillis / summary.revenue.current) * 100)} of revenue
                  {consumption.unmappedUnits > 0 && " · understated while dishes remain uncosted"}
                </p>
              )}
            </CardContent>
          </>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ waste report */

async function WasteReport({
  scope,
  range,
  currency,
  periodHint,
  multiLocation,
}: {
  scope: Scope;
  range: DateRange;
  currency: string;
  periodHint: string;
  multiLocation: boolean;
}) {
  const [summary, trend, byReason, byIngredient, byLocation] = await Promise.all([
    getWasteSummary(scope, range),
    getWasteTrendSeries(scope, range, iso => bucketLabel(iso, range.granularity)),
    getWasteByReason(scope, range),
    getWasteByIngredient(scope, range, 15),
    multiLocation ? getWasteByLocation(scope, range) : Promise.resolve([]),
  ]);

  if (summary.events === 0) {
    return (
      <Card>
        <EmptyState
          icon={Trash2}
          title="No waste data yet"
          description="Record your first waste entry to start tracking waste costs."
          action={{ label: "Record waste", href: "/dashboard/waste" }}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryTile label="Total waste cost" value={formatMoney(summary.cost.current, currency)} hint={periodHint} tone="danger" />
        <SummaryTile label="Waste entries" value={String(summary.events)} hint={`${summary.ingredientCount} ingredient${summary.ingredientCount === 1 ? "" : "s"} affected`} />
        <SummaryTile
          label="vs previous period"
          value={summary.cost.changePercent === null ? "—" : `${summary.cost.changePercent > 0 ? "+" : ""}${formatPercent(summary.cost.changePercent)}`}
          hint={summary.cost.changePercent === null ? "No comparable history" : `${formatMoney(summary.cost.previous, currency)} before`}
          tone={summary.cost.changePercent !== null && summary.cost.changePercent > 0 ? "danger" : "success"}
        />
      </div>

      <Card>
        <CardHeader className="border-b">
          <h3 className="font-black">Waste over time</h3>
          <p className="text-sm text-[var(--muted)]">
            {range.granularity === "day" ? "Daily" : range.granularity === "week" ? "Weekly" : "Monthly"} totals · {periodHint}
          </p>
        </CardHeader>
        <CardContent>
          <WasteChart data={trend} currency={currency} />
        </CardContent>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader>
            <h3 className="font-black">Waste by reason</h3>
            <p className="text-sm text-[var(--muted)]">What is driving the loss</p>
          </CardHeader>
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Reason</TH>
                <TH className="text-right">Entries</TH>
                <TH className="text-right">Cost</TH>
                <TH className="text-right">Share</TH>
              </TR>
            </THead>
            <TBody>
              {byReason.map(row => (
                <TR key={row.reason}>
                  <TD>
                    <b className="text-sm">{wasteReasonLabel(row.reason)}</b>
                  </TD>
                  <TDNum>{row.events}</TDNum>
                  <TDNum className="font-semibold">{formatMoney(row.cost, currency)}</TDNum>
                  <TDNum>{formatPercent(row.sharePercent, 0)}</TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader>
            <h3 className="font-black">Highest waste contributors</h3>
            <p className="text-sm text-[var(--muted)]">Ingredients ranked by cost lost</p>
          </CardHeader>
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Ingredient</TH>
                <TH className="text-right">Quantity</TH>
                <TH className="text-right">Entries</TH>
                <TH className="text-right">Cost</TH>
              </TR>
            </THead>
            <TBody>
              {byIngredient.map(row => (
                <TR key={row.ingredientId}>
                  <TD>
                    <b className="text-sm">{row.ingredientName}</b>
                  </TD>
                  <TDNum>{formatQuantity(row.quantity, row.unit)}</TDNum>
                  <TDNum>{row.events}</TDNum>
                  <TDNum className="font-semibold text-red-700">{formatMoney(row.cost, currency)}</TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>

      {multiLocation && byLocation.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader>
            <h3 className="font-black">Waste by location</h3>
            <p className="text-sm text-[var(--muted)]">Every location in the organization · {range.label}</p>
          </CardHeader>
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Location</TH>
                <TH className="text-right">Entries</TH>
                <TH className="text-right">Cost</TH>
              </TR>
            </THead>
            <TBody>
              {byLocation.map(row => (
                <TR key={row.locationId}>
                  <TD>
                    <b className="text-sm">{row.locationName}</b>
                  </TD>
                  <TDNum>{row.events}</TDNum>
                  <TDNum className="font-semibold">{formatMoney(row.cost, currency)}</TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

/* -------------------------------------------------------- inventory valuation */

async function InventoryReport({
  scope,
  range,
  organizationId,
  currency,
  locationName,
  multiLocation,
}: {
  scope: Scope;
  range: DateRange;
  organizationId: string;
  currency: string;
  locationName: string;
  multiLocation: boolean;
}) {
  const [snapshot, byLocation, movements] = await Promise.all([
    getInventorySnapshot(scope),
    multiLocation ? getInventoryValueByLocation(organizationId) : Promise.resolve([]),
    listRecentMovements(scope, range, 12),
  ]);

  if (snapshot.activeCount === 0) {
    return (
      <Card>
        <EmptyState
          icon={PackageSearch}
          title="No ingredients yet"
          description="Add your ingredients and receive a purchase invoice to value your inventory."
          action={{ label: "Add ingredients", href: "/dashboard/ingredients" }}
        />
      </Card>
    );
  }

  const byCategory = getInventoryValueByCategory(snapshot.rows);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-4">
        <SummaryTile label="Inventory value" value={formatMoney(snapshot.totalValueMillis, currency)} hint={locationName} tone="success" />
        <SummaryTile label="Active ingredients" value={String(snapshot.activeCount)} hint="Tracked in this workspace" />
        <SummaryTile label="Low stock" value={String(snapshot.lowStock.length)} hint="At or below minimum" tone={snapshot.lowStock.length > 0 ? "danger" : "neutral"} />
        <SummaryTile label="Out of stock" value={String(snapshot.outOfStock.length)} hint="Nothing on hand" tone={snapshot.outOfStock.length > 0 ? "danger" : "neutral"} />
      </div>

      {snapshot.totalValueMillis === 0 ? (
        <Card>
          <EmptyState
            icon={Coins}
            title="No stock value yet"
            description="Your ingredients have no stock on hand, or no cost recorded. Receive a purchase invoice to value them."
            action={{ label: "Receive purchase", href: "/dashboard/purchases?view=new" }}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <CardHeader>
            <h3 className="font-black">Value by ingredient</h3>
            <p className="text-sm text-[var(--muted)]">Stock on hand at the latest known unit cost · {locationName}</p>
          </CardHeader>
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Ingredient</TH>
                <TH>Category</TH>
                <TH className="text-right">On hand</TH>
                <TH className="text-right">Unit cost</TH>
                <TH className="text-right">Value</TH>
                <TH className="text-right">Status</TH>
              </TR>
            </THead>
            <TBody>
              {snapshot.topByValue.slice(0, 25).map(row => (
                <TR key={row.id}>
                  <TD>
                    <b className="text-sm">{row.name}</b>
                  </TD>
                  <TD className="text-sm text-[var(--muted)]">{row.category ?? "—"}</TD>
                  <TDNum>{formatQuantity(row.stock, row.unit)}</TDNum>
                  <TDNum>{formatMoney(row.unitCostMillis, currency)}</TDNum>
                  <TDNum className="font-semibold">{formatMoney(row.valueMillis, currency)}</TDNum>
                  <TDNum>
                    {row.stock <= 0 ? (
                      <Badge tone="danger">Out</Badge>
                    ) : row.minimum > 0 && row.stock <= row.minimum ? (
                      <Badge tone="warning">Low</Badge>
                    ) : (
                      <Badge tone="success">OK</Badge>
                    )}
                  </TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader>
            <h3 className="font-black">Value by category</h3>
            <p className="text-sm text-[var(--muted)]">Ingredients without a category are grouped together</p>
          </CardHeader>
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Category</TH>
                <TH className="text-right">Ingredients</TH>
                <TH className="text-right">Value</TH>
              </TR>
            </THead>
            <TBody>
              {byCategory.map(row => (
                <TR key={row.category}>
                  <TD>
                    <b className="text-sm">{row.category}</b>
                  </TD>
                  <TDNum>{row.ingredientCount}</TDNum>
                  <TDNum className="font-semibold">{formatMoney(row.valueMillis, currency)}</TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>

        {multiLocation && (
          <Card className="overflow-hidden">
            <CardHeader>
              <h3 className="font-black">Value by location</h3>
              <p className="text-sm text-[var(--muted)]">Every location in the organization</p>
            </CardHeader>
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Location</TH>
                  <TH className="text-right">Value</TH>
                </TR>
              </THead>
              <TBody>
                {byLocation.map(row => (
                  <TR key={row.locationId}>
                    <TD>
                      <b className="text-sm">{row.locationName}</b>
                    </TD>
                    <TDNum className="font-semibold">{formatMoney(row.valueMillis, currency)}</TDNum>
                  </TR>
                ))}
              </TBody>
            </Table>
          </Card>
        )}
      </div>

      {snapshot.lowStock.length + snapshot.outOfStock.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader>
            <h3 className="font-black">Needs reordering</h3>
            <p className="text-sm text-[var(--muted)]">Against the minimum stock level you set for each ingredient</p>
          </CardHeader>
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Ingredient</TH>
                <TH className="text-right">Current</TH>
                <TH className="text-right">Minimum</TH>
                <TH className="text-right">Status</TH>
              </TR>
            </THead>
            <TBody>
              {[...snapshot.outOfStock, ...snapshot.lowStock].map(row => (
                <TR key={row.id}>
                  <TD>
                    <b className="text-sm">{row.name}</b>
                  </TD>
                  <TDNum>{formatQuantity(row.stock, row.unit)}</TDNum>
                  <TDNum>{row.minimum > 0 ? formatQuantity(row.minimum, row.unit) : "—"}</TDNum>
                  <TDNum>
                    <Badge tone={row.stock <= 0 ? "danger" : "warning"}>{row.stock <= 0 ? "Critical" : "Low"}</Badge>
                  </TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      {movements.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader>
            <h3 className="font-black">Recent stock movements</h3>
            <p className="text-sm text-[var(--muted)]">The ledger entries behind these balances · {locationName}</p>
          </CardHeader>
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Ingredient</TH>
                <TH>Type</TH>
                <TH>Location</TH>
                <TH className="text-right">Quantity</TH>
                <TH className="text-right">Date</TH>
              </TR>
            </THead>
            <TBody>
              {movements.map(movement => (
                <TR key={movement.id}>
                  <TD>
                    <b className="text-sm">{movement.ingredientName}</b>
                  </TD>
                  <TD className="text-sm text-[var(--muted)]">{movement.type.replace(/_/g, " ")}</TD>
                  <TD className="text-sm text-[var(--muted)]">{movement.locationName}</TD>
                  <TDNum className={cn("font-semibold", movement.quantity < 0 ? "text-red-700" : "text-green-800")}>
                    {movement.quantity > 0 ? "+" : ""}
                    {formatQuantity(movement.quantity, movement.unit)}
                  </TDNum>
                  <TDNum className="text-xs text-[var(--muted)]">{movement.occurredAt.toLocaleDateString()}</TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ supplier prices */

async function SupplierPriceReport({ scope, range, currency }: { scope: Scope; range: DateRange; currency: string }) {
  const [changes, comparison, spend] = await Promise.all([
    getSupplierPriceChanges(scope.organizationId, 50),
    getSupplierComparison(scope.organizationId),
    getSupplierSpend(scope, range),
  ]);

  if (changes.length === 0 && spend.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={ReceiptText}
          title="No purchase history yet"
          description="Supplier prices are derived from the invoices you record. Receive a purchase to start tracking what you pay."
          action={{ label: "Receive purchase", href: "/dashboard/purchases?view=new" }}
        />
      </Card>
    );
  }

  const increases = changes.filter(row => (row.changePercent ?? 0) > 0);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryTile label="Tracked prices" value={String(changes.length)} hint="Supplier + ingredient pairings" />
        <SummaryTile label="Price increases" value={String(increases.length)} hint="Latest price above the one before" tone={increases.length > 0 ? "danger" : "success"} />
        <SummaryTile label="Multi-supplier items" value={String(comparison.length)} hint="Ingredients you can price-shop" />
      </div>

      {spend.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader>
            <h3 className="font-black">Suppliers</h3>
            <p className="text-sm text-[var(--muted)]">Spend in the selected period, with how many products each supplier lists</p>
          </CardHeader>
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Supplier</TH>
                <TH className="text-right">Products</TH>
                <TH className="text-right">Invoices</TH>
                <TH className="text-right">Spend</TH>
              </TR>
            </THead>
            <TBody>
              {spend.map(row => (
                <TR key={row.supplierId}>
                  <TD>
                    <b className="text-sm">{row.name}</b>
                  </TD>
                  <TDNum>{row.productCount}</TDNum>
                  <TDNum>{row.invoiceCount}</TDNum>
                  <TDNum className="font-semibold">{formatMoney(row.spendMillis, currency)}</TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      {changes.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader>
            <h3 className="font-black">Price changes</h3>
            <p className="text-sm text-[var(--muted)]">Latest price paid against the previous one, per base unit, from your own invoices</p>
          </CardHeader>
          <Table className="min-w-[820px]">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Ingredient</TH>
                <TH>Supplier</TH>
                <TH className="text-right">Previous</TH>
                <TH className="text-right">Current</TH>
                <TH className="text-right">Change</TH>
                <TH className="text-right">Last bought</TH>
              </TR>
            </THead>
            <TBody>
              {changes.map(row => (
                <TR key={`${row.ingredientId}-${row.supplierId ?? "none"}`}>
                  <TD>
                    <b className="text-sm">{row.ingredientName}</b>
                    <span className="block text-xs text-[var(--muted)]">per {row.baseUnitCode}</span>
                  </TD>
                  <TD className="text-sm">{row.supplierName ?? "—"}</TD>
                  <TDNum>{row.previousPriceMillis === null ? <span className="text-[var(--muted)]">—</span> : formatMoney(row.previousPriceMillis, currency)}</TDNum>
                  <TDNum className="font-semibold">{formatMoney(row.currentPriceMillis, currency)}</TDNum>
                  <TDNum>
                    {row.changePercent === null ? (
                      <span className="text-xs text-[var(--muted)]">First purchase</span>
                    ) : (
                      <Badge tone={row.changePercent > 0 ? "danger" : row.changePercent < 0 ? "success" : "neutral"}>
                        {row.changePercent > 0 ? "+" : ""}
                        {formatPercent(row.changePercent)}
                      </Badge>
                    )}
                  </TDNum>
                  <TDNum className="text-xs text-[var(--muted)]">{row.purchasedAt.toLocaleDateString()}</TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <h3 className="font-black">Cheapest supplier per ingredient</h3>
          <p className="text-sm text-[var(--muted)]">
            {comparison.length > 0 ? "Ingredients offered by more than one supplier, with the spread between cheapest and dearest" : "Needs at least two suppliers on the same ingredient"}
          </p>
        </CardHeader>
        {comparison.length === 0 ? (
          <EmptyState
            icon={ReceiptText}
            title="Nothing to compare yet"
            description="Add the same ingredient to a second supplier's catalog to see which one is cheaper."
            action={{ label: "Open suppliers", href: "/dashboard/suppliers" }}
            className="py-8"
          />
        ) : (
          <div className="divide-y">
            {comparison.map(row => (
              <div key={row.ingredientId} className="px-5 py-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <b className="text-sm">{row.ingredientName}</b>
                  <span className="text-xs text-[var(--muted)]">
                    Spread <b className="tabular-nums text-[var(--foreground)]">{formatMoney(row.savingsMillis, currency)}</b>
                  </span>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {row.offers.map(offer => {
                    const cheapest = offer.supplierId === row.cheapestSupplierId;
                    return (
                      <div
                        key={offer.supplierId}
                        className={cn("flex items-center justify-between gap-2 rounded-lg border p-2.5", cheapest && "border-green-300 bg-green-50/60")}
                      >
                        <span className="min-w-0 truncate text-sm">{offer.supplierName}</span>
                        <span className="flex shrink-0 items-center gap-2">
                          <b className="text-sm tabular-nums">
                            {formatMoney(offer.lastPriceMillis, currency)}
                            <span className="font-normal text-[var(--muted)]">/{offer.packUnitCode ?? row.baseUnitCode}</span>
                          </b>
                          {cheapest && <Badge tone="success">Cheapest</Badge>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

/* -------------------------------------------------------- menu profitability */

async function MenuProfitabilityReport({ organizationId, currency }: { organizationId: string; currency: string }) {
  const units = await getOrganizationUnits(organizationId);
  const menuItems = await listMenuItems(organizationId, units, { status: "active" });

  if (menuItems.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={UtensilsCrossed}
          title="No menu items yet"
          description="Create a menu item and connect it to a recipe to start measuring profitability."
          action={{ label: "Build your menu", href: "/dashboard/menu" }}
        />
      </Card>
    );
  }

  const costed = menuItems.filter(item => item.economics.isCosted);
  if (costed.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={UtensilsCrossed}
          title="Nothing costed yet"
          description="Your menu items have no ingredients attached, so food cost and margin cannot be calculated. Add what goes into each dish to see its profit."
          action={{ label: "Open menu", href: "/dashboard/menu" }}
        />
      </Card>
    );
  }

  // Ranked by gross profit per sale — the figure a menu decision turns on.
  const ranked = [...costed].sort((a, b) => b.economics.grossProfitMillis - a.economics.grossProfitMillis);
  const warning = ranked.filter(item => item.economics.foodCostPercent > 35);
  const totalRevenue = costed.reduce((total, item) => total + item.sellingPriceMillis, 0);
  const totalCost = costed.reduce((total, item) => total + item.economics.totalCostMillis, 0);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-4">
        <SummaryTile label="Costed items" value={`${costed.length} / ${menuItems.length}`} hint="Menu items with a composition" />
        <SummaryTile label="Combined menu price" value={formatMoney(totalRevenue, currency)} hint="One of each costed item" />
        <SummaryTile label="Combined plate cost" value={formatMoney(totalCost, currency)} hint="Including packaging" />
        <SummaryTile label="High food cost" value={String(warning.length)} hint="Above the 35% watch line" tone={warning.length > 0 ? "danger" : "success"} />
      </div>

      {warning.length > 0 && (
        <Card className="border-red-200 bg-red-50/40">
          <CardContent className="pt-5">
            <p className="flex items-center gap-2 text-sm font-black text-red-800">
              <TrendingUp size={16} /> {warning.length} item{warning.length === 1 ? "" : "s"} eroding margin
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {warning.map(item => (
                <span key={item.id} className="inline-flex items-center gap-2 rounded-full border border-red-200 bg-white px-3 py-1.5 text-sm">
                  {item.name}
                  <Badge tone="danger">{formatPercent(item.economics.foodCostPercent)}</Badge>
                </span>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <h3 className="font-black">Profitability ranking</h3>
          <p className="text-sm text-[var(--muted)]">Priced against live ingredient costs, most profitable first</p>
        </CardHeader>
        <Table className="min-w-[860px]">
          <THead>
            <TR className="hover:bg-transparent">
              <TH className="w-12">#</TH>
              <TH>Menu item</TH>
              <TH className="text-right">Selling price</TH>
              <TH className="text-right">Recipe cost</TH>
              <TH className="text-right">Food cost %</TH>
              <TH className="text-right">Gross profit</TH>
              <TH className="text-right">Margin</TH>
            </TR>
          </THead>
          <TBody>
            {ranked.map((item, index) => (
              <TR key={item.id}>
                <TD className="text-sm font-black text-[var(--muted)]">{index + 1}</TD>
                <TD>
                  <b className="text-sm">{item.name}</b>
                  {item.category && <span className="block text-xs text-[var(--muted)]">{item.category}</span>}
                </TD>
                <TDNum>{formatMoney(item.sellingPriceMillis, currency)}</TDNum>
                <TDNum>
                  {formatMoney(item.economics.totalCostMillis, currency)}
                  {item.packagingCostMillis > 0 && <span className="block text-xs text-[var(--muted)]">incl. packaging</span>}
                </TDNum>
                <TDNum>
                  <Badge tone={foodCostTone(item.economics.foodCostPercent)}>{formatPercent(item.economics.foodCostPercent)}</Badge>
                </TDNum>
                <TDNum className={cn("font-semibold", item.economics.grossProfitMillis < 0 ? "text-red-700" : "text-green-800")}>
                  {formatMoney(item.economics.grossProfitMillis, currency)}
                </TDNum>
                <TDNum>{formatPercent(item.economics.grossMarginPercent)}</TDNum>
              </TR>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}
