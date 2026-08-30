import { redirect } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowRight, ChefHat, ClipboardList, Coins, PackagePlus, PackageSearch, Percent, Receipt, ReceiptText, ShoppingCart, TrendingUp, Trash2, UtensilsCrossed, type LucideIcon } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { AnalyticsFilters } from "@/components/dashboard/analytics-filters";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { Section } from "@/components/dashboard/section";
import { WasteChart } from "@/components/charts/waste-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { averageMarginOrNull, foodCostTone, menuFoodCostPercent } from "@/lib/costing";
import { bucketLabel } from "@/lib/date-range";
import { formatMoney, formatPercent } from "@/lib/money";
import { formatQuantity } from "@/lib/units";
import { cn } from "@/lib/utils";
import { wasteReasonLabel } from "@/lib/waste-reasons";
import { getAnalyticsContext, type AnalyticsSearchParams } from "@/server/analytics-context";
import {
  getInventorySnapshot,
  getLocationStockAlerts,
  summarizeLocationStockAlerts,
  getPurchaseTotals,
  getSupplierPriceChanges,
  getWasteByReason,
  getWasteSummary,
  getWasteTrendSeries,
  listRecentPurchases,
  listRecentWaste,
} from "@/server/queries/analytics";
import { listMenuItems } from "@/server/queries/menu";
import { getSalesByMenuItem, getSalesSummary } from "@/server/queries/sales";
import { getSetupProgress } from "@/server/queries/onboarding";
import { getOrganizationUnits } from "@/server/tenant";

export const metadata = { title: "Overview" };

export default async function DashboardPage({ searchParams }: { searchParams: Promise<AnalyticsSearchParams> }) {
  const params = await searchParams;
  const { tenant, range, location, scope, fromInput, toInput } = await getAnalyticsContext(params);

  // Until the guided setup is finished, the checklist is the dashboard.
  const setup = await getSetupProgress(tenant.organizationId);
  if (!tenant.onboardingCompletedAt && !setup.allStepsComplete) redirect("/onboarding");

  const units = await getOrganizationUnits(tenant.organizationId);

  const [inventory, locationStockAlerts, purchaseTotals, waste, wasteTrend, wasteByReason, recentPurchases, recentWaste, menuItems, priceChanges, salesSummary, topSellers] = await Promise.all([
    getInventorySnapshot(scope),
    scope.locationId ? Promise.resolve([]) : getLocationStockAlerts(tenant.organizationId),
    getPurchaseTotals(scope, range),
    getWasteSummary(scope, range),
    getWasteTrendSeries(scope, range, iso => bucketLabel(iso, range.granularity)),
    getWasteByReason(scope, range),
    listRecentPurchases(scope, range, 5),
    listRecentWaste(scope, range, 5),
    listMenuItems(tenant.organizationId, units, { status: "active" }),
    getSupplierPriceChanges(tenant.organizationId, 5),
    getSalesSummary(scope, range),
    getSalesByMenuItem(scope, range, 5),
  ]);

  const costedItems = menuItems.filter(item => item.economics.isCosted);
  const economics = menuItems.map(item => ({
    sellingPriceMillis: item.sellingPriceMillis,
    totalCostMillis: item.economics.totalCostMillis,
    isCosted: item.economics.isCosted,
  }));
  const foodCost = menuFoodCostPercent(economics);
  const margin = averageMarginOrNull(economics);

  const topMenuItems = [...costedItems].sort((a, b) => b.economics.grossMarginPercent - a.economics.grossMarginPercent).slice(0, 5);
  const highFoodCost = costedItems.filter(item => item.economics.foodCostPercent > 35).sort((a, b) => b.economics.foodCostPercent - a.economics.foodCostPercent).slice(0, 5);
  const risingPrices = priceChanges.filter(row => (row.changePercent ?? 0) > 0);
  const periodHint = `${range.label} · ${location.name}`;

  // All-location inventory value is intentionally aggregate, but stock health is
  // evaluated per shelf so one branch cannot hide another branch's shortage.
  const locationAlertSummary = summarizeLocationStockAlerts(locationStockAlerts);
  const locationAttentionCount = locationAlertSummary.total;
  const attentionCount = scope.locationId
    ? inventory.outOfStock.length + inventory.lowStock.length
    : locationAlertSummary.total;
  const affectedLocationNames = locationAlertSummary.locations.map(item => item.name).join(", ");

  return (
    <>
      <PageHeader
        eyebrow="Today"
        title="Operations overview"
        description="Know what changed, what is at risk, and where profit is leaking. Every figure below is calculated from this workspace's own records."
      />

      <AnalyticsFilters
        locations={location.options}
        currentPreset={range.preset}
        currentLocationId={location.id}
        from={fromInput}
        to={toInput}
        className="mb-4"
      />

      <div className="mb-5 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-stretch">
        <div className={attentionCount > 0 ? "rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-950 shadow-sm" : "rounded-lg border bg-white px-4 py-3 text-sm text-[var(--muted)] shadow-sm"}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>
              <b className={attentionCount > 0 ? "text-amber-950" : "text-[var(--foreground)]"}>
                {attentionCount > 0
                  ? String(attentionCount) + " inventory item" + (attentionCount === 1 ? "" : "s") + " need attention"
                  : "No urgent stock issues"}
              </b>
              <span className="ml-2">
                {scope.locationId
                  ? `${inventory.outOfStock.length} out · ${inventory.lowStock.length} low · ${location.name}`
                  : `${locationAlertSummary.out} out · ${locationAlertSummary.low} low · ${locationAttentionCount} location alerts · ${affectedLocationNames || "All locations"}`}
              </span>
            </p>
            <Link href="/dashboard/inventory" className="inline-flex items-center gap-1 font-semibold text-green-900 hover:underline">
              Open inventory <ArrowRight size={14} />
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[34rem]">
          <QuickAction href="/dashboard/purchases?view=new" icon={PackagePlus} label="Receive" />
          <QuickAction href="/dashboard/sales" icon={Receipt} label="Sale" />
          <QuickAction href="/dashboard/waste" icon={Trash2} label="Waste" />
          <QuickAction href="/dashboard/inventory/counts" icon={ClipboardList} label="Count" />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard
          label="Inventory value"
          value={formatMoney(inventory.totalValueMillis, tenant.currency)}
          hint={`${inventory.activeCount} active ingredients · ${location.name}`}
          icon={Coins}
        />
        <KpiCard
          label="Purchases"
          value={formatMoney(purchaseTotals.current, tenant.currency)}
          hint={purchaseTotals.changePercent === null ? periodHint : `vs previous period · ${purchaseTotals.invoiceCount} invoices`}
          icon={ShoppingCart}
          change={purchaseTotals.changePercent}
        />
        <KpiCard
          label="Waste"
          value={formatMoney(waste.cost.current, tenant.currency)}
          hint={waste.cost.changePercent === null ? periodHint : `vs previous period · ${waste.events} entries`}
          icon={Trash2}
          change={waste.cost.changePercent}
          invertChange
          emphasis={waste.cost.current > 0 ? "warning" : "neutral"}
        />
        <KpiCard
          label="Food cost"
          value={foodCost === null ? "—" : formatPercent(foodCost)}
          hint={foodCost === null ? "Needs a costed menu item" : "Share of menu price spent on ingredients"}
          icon={Percent}
          emphasis={foodCost === null ? "neutral" : foodCostTone(foodCost) === "danger" ? "danger" : foodCostTone(foodCost) === "warning" ? "warning" : "success"}
        />
        <KpiCard
          label="Average margin"
          value={margin === null ? "—" : formatPercent(margin)}
          hint={margin === null ? "Link a recipe to a menu item" : `Across ${costedItems.length} costed items`}
          icon={TrendingUp}
          emphasis={margin === null ? "neutral" : "success"}
        />
      </div>

      {/* ---------------------------------------------------- operational insights */}
      <Section
        title="Needs attention"
        description={attentionCount > 0
          ? `${attentionCount} item${attentionCount === 1 ? "" : "s"} worth a look before anything else${!scope.locationId && affectedLocationNames ? ` · ${affectedLocationNames}` : ""}`
          : "Nothing is broken right now"}
        tone={attentionCount > 0 ? "alert" : "default"}
      >
        <div className="grid gap-3 xl:grid-cols-3">
          {locationStockAlerts.length > 0 && (
            <DashboardCard
              title="Location stock alerts"
              subtitle={`${locationAlertSummary.out} out · ${locationAlertSummary.low} low · ${locationAlertSummary.locations.length} affected location${locationAlertSummary.locations.length === 1 ? "" : "s"}`}
              headerClassName="bg-red-50/40"
              heightClassName="lg:h-[28rem]"
            >
              <div className="space-y-3">
                {locationStockAlerts.map(item => (
                  <div key={`${item.locationId}:${item.ingredientId}`} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0">
                      <b className="block truncate text-sm">{item.ingredientName}</b>
                      <p className="text-xs text-[var(--muted)]">
                        {item.locationName} · Current: {formatQuantity(item.stock, item.unit)}
                        {item.minimum > 0 && ` · Minimum: ${formatQuantity(item.minimum, item.unit)}`}
                      </p>
                    </div>
                    <Badge tone={item.status === "out" ? "danger" : "warning"}>{item.status === "out" ? "Out" : "Low"}</Badge>
                  </div>
                ))}
              </div>
            </DashboardCard>
          )}
          <DashboardCard
            title="Low stock"
            subtitle="At or below the minimum you set"
            headerClassName="bg-amber-50/40"
            heightClassName="lg:h-[28rem]"
            footer={
              (scope.locationId ? inventory.outOfStock.length > 0 || inventory.lowStock.length > 0 : locationAlertSummary.total > 0) ? (
                <Link href="/dashboard/inventory">
                  <Button variant="secondary" className="w-full">
                    View full inventory <ArrowRight size={16} />
                  </Button>
                </Link>
              ) : null
            }
          >
            {(scope.locationId ? inventory.outOfStock.length === 0 && inventory.lowStock.length === 0 : locationAlertSummary.total === 0) ? (
              <EmptyState
                icon={PackageSearch}
                title={
                  inventory.activeCount === 0
                    ? "No ingredients yet"
                    : locationAlertSummary.total > 0
                      ? "Combined stock hides branch shortages"
                      : "Everything is stocked"
                }
                description={
                  inventory.activeCount === 0
                    ? "Add your ingredients to start tracking stock levels and low-stock alerts."
                    : locationAlertSummary.total > 0
                      ? `${locationAlertSummary.total} location-level alert${locationAlertSummary.total === 1 ? "" : "s"} remain at ${affectedLocationNames}. Review the location stock alerts.`
                      : "No ingredient is at or below its minimum level right now."
                }
                action={inventory.activeCount === 0 ? { label: "Add ingredients", href: "/dashboard/ingredients" } : undefined}
                className="py-6"
              />
            ) : (
              <div className="space-y-3">
                {(scope.locationId ? [...inventory.outOfStock, ...inventory.lowStock] : locationStockAlerts).map(item => (
                  <div key={"locationId" in item ? `${item.locationId}:${item.ingredientId}` : item.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0">
                      <b className="block truncate text-sm">{"locationName" in item ? item.ingredientName : item.name}</b>
                      <p className="text-xs text-[var(--muted)]">
                        {"locationName" in item && `${item.locationName} · `}Current: {formatQuantity(item.stock, item.unit)}
                        {item.minimum > 0 && ` · Minimum: ${formatQuantity(item.minimum, item.unit)}`}
                      </p>
                    </div>
                    <Badge tone={item.stock <= 0 ? "danger" : "warning"}>{item.stock <= 0 ? "Out" : "Low"}</Badge>
                  </div>
                ))}
              </div>
            )}
          </DashboardCard>

          <DashboardCard title="Recent purchases" subtitle={periodHint} heightClassName="lg:h-[28rem]">
              {recentPurchases.length === 0 ? (
                <EmptyState
                  icon={ReceiptText}
                  title="No purchases in this period"
                  description="Record a supplier invoice to put stock on hand and start building your cost history."
                  action={{ label: "Receive purchase", href: "/dashboard/purchases?view=new" }}
                  className="py-6"
                />
              ) : (
                <>
                  {recentPurchases.map(purchase => (
                    <Link key={purchase.id} href={`/dashboard/purchases/${purchase.id}`} className="flex items-center justify-between gap-3 rounded-lg border p-3 transition hover:bg-neutral-50">
                      <div className="min-w-0">
                        <b className="block truncate text-sm">{purchase.supplierName ?? "No supplier"}</b>
                        <p className="text-xs text-[var(--muted)]">
                          {purchase.invoiceNumber ? `${purchase.invoiceNumber} · ` : ""}
                          {purchase.itemCount} line{purchase.itemCount === 1 ? "" : "s"} · {purchase.receivedAt.toLocaleDateString()}
                        </p>
                      </div>
                      <b className="shrink-0 text-sm tabular-nums">{formatMoney(purchase.totalMillis, tenant.currency)}</b>
                    </Link>
                  ))}
                </>
              )}
          </DashboardCard>

          <DashboardCard title="Recent waste" subtitle={periodHint} heightClassName="lg:h-[28rem]">
              {recentWaste.length === 0 ? (
                <EmptyState
                  icon={Trash2}
                  title="No waste data yet"
                  description="Record your first waste entry to start tracking waste costs."
                  action={{ label: "Record waste", href: "/dashboard/waste" }}
                  className="py-6"
                />
              ) : (
                recentWaste.map(entry => (
                  <div key={entry.id} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                    <div className="min-w-0">
                      <b className="block truncate text-sm">{entry.ingredientName}</b>
                      <p className="text-xs text-[var(--muted)]">
                        {wasteReasonLabel(entry.reason)} · {formatQuantity(entry.quantity, entry.unit)} · {entry.occurredAt.toLocaleDateString()}
                      </p>
                    </div>
                    <b className="shrink-0 text-sm tabular-nums text-red-700">{formatMoney(entry.costMillis, tenant.currency)}</b>
                  </div>
                ))
              )}
          </DashboardCard>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- analytics */}
      <Section
        title="Analytics"
        description="Where the money sits, where it is going and what it is doing to your margin"
      >
        <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
          <DashboardCard
            title="Waste cost trend"
            subtitle={waste.events > 0
              ? `${formatMoney(waste.cost.current, tenant.currency)} lost · ${waste.events} entries · ${range.granularity === "day" ? "daily" : range.granularity === "week" ? "weekly" : "monthly"}`
              : periodHint}
            heightClassName="lg:h-[27rem]"
            bodyClassName="flex flex-col"
          >
            {waste.events === 0 ? (
              <EmptyState
                icon={AlertTriangle}
                title="No waste data yet"
                description="Record your first waste entry to start tracking waste costs."
                action={{ label: "Record waste", href: "/dashboard/waste" }}
                className="py-8"
              />
            ) : waste.cost.current === 0 ? (
              <EmptyState
                icon={AlertTriangle}
                title="Waste recorded, but not costed"
                description={`${waste.events} entr${waste.events === 1 ? "y" : "ies"} in this period involve ingredients that have no unit cost yet, so there is nothing to plot. Receive a purchase invoice to price them.`}
                action={{ label: "Receive purchase", href: "/dashboard/purchases?view=new" }}
                className="py-8"
              />
            ) : (
              <WasteChart data={wasteTrend} currency={tenant.currency} />
            )}
          </DashboardCard>

          <DashboardCard title="Waste by reason" subtitle="Where the loss comes from" heightClassName="lg:h-[27rem]">
            {wasteByReason.length === 0 ? (
              <EmptyState icon={Trash2} title="Nothing logged" description="Waste reasons appear once entries are recorded." className="py-6" />
            ) : (
              wasteByReason.map(row => (
                <div key={row.reason}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="font-semibold">{wasteReasonLabel(row.reason)}</span>
                    <span className="tabular-nums">{formatMoney(row.cost, tenant.currency)}</span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-neutral-100">
                    <div className="h-full rounded-full bg-amber-500" style={{ width: `${Math.max(row.sharePercent, 2)}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {formatPercent(row.sharePercent, 0)} of waste · {row.events} entr{row.events === 1 ? "y" : "ies"}
                  </p>
                </div>
              ))
            )}
          </DashboardCard>
        </div>

        <div className="mt-6 grid gap-5 xl:grid-cols-2">
          <DashboardCard title="Top ingredient costs" subtitle={`Where inventory money is tied up · ${location.name}`} heightClassName="lg:h-[25rem]">
            {inventory.topByValue.length === 0 ? (
              <EmptyState
                icon={Coins}
                title="No stock value yet"
                description="Receive a purchase invoice to put stock on hand and value your inventory."
                action={{ label: "Receive purchase", href: "/dashboard/purchases?view=new" }}
                className="py-6"
              />
            ) : (
              inventory.topByValue.map(item => {
                const share = inventory.totalValueMillis > 0 ? (item.valueMillis / inventory.totalValueMillis) * 100 : 0;
                return (
                  <div key={item.id}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate font-semibold">{item.name}</span>
                      <span className="shrink-0 tabular-nums">{formatMoney(item.valueMillis, tenant.currency)}</span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-neutral-100">
                      <div className="h-full rounded-full bg-green-700" style={{ width: `${Math.max(share, 2)}%` }} />
                    </div>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {formatQuantity(item.stock, item.unit)} @ {formatMoney(item.unitCostMillis, tenant.currency)}/{item.unit}
                    </p>
                  </div>
                );
              })
            )}
          </DashboardCard>

          <DashboardCard title="Ingredients getting expensive" subtitle="Latest price paid vs the time before" heightClassName="lg:h-[25rem]">
            {risingPrices.length === 0 ? (
              <EmptyState
                icon={ReceiptText}
                title="No price increases detected"
                description="Once the same ingredient is bought twice, price movements appear here."
                action={{ label: "View suppliers", href: "/dashboard/suppliers" }}
                className="py-6"
              />
            ) : (
              risingPrices.map(row => (
                <div key={`${row.ingredientId}-${row.supplierId ?? "none"}`} className="flex items-center justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <b className="block truncate text-sm">{row.ingredientName}</b>
                    <p className="text-xs text-[var(--muted)]">
                      {row.supplierName ?? "No supplier"} · {formatMoney(row.previousPriceMillis ?? 0, tenant.currency)} →{" "}
                      {formatMoney(row.currentPriceMillis, tenant.currency)}/{row.baseUnitCode}
                    </p>
                  </div>
                  <Badge tone="danger">+{formatPercent(row.changePercent ?? 0)}</Badge>
                </div>
              ))
            )}
          </DashboardCard>
        </div>
      </Section>

      {/* -------------------------------------------------------------------- sales */}
      <Section title="Sales" description="Actual revenue this period, and what is selling" action={{ label: "View all sales", href: "/dashboard/sales" }}>
        {salesSummary.transactions.current === 0 ? (
          <Card>
            <EmptyState
              icon={Receipt}
              title="No sales in this period"
              description="Record sales to measure real revenue against your menu costs, and to see how much stock your menu should be consuming."
              action={{ label: "Record a sale", href: "/dashboard/sales" }}
              className="py-8"
            />
          </Card>
        ) : (
          <div className="grid gap-5 xl:grid-cols-[1fr_1.4fr]">
            <DashboardCard title="This period" subtitle={periodHint} heightClassName="lg:h-[21rem]">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-[var(--muted)]">Revenue</span>
                <b className="text-2xl font-black tabular-nums text-green-800">{formatMoney(salesSummary.revenue.current, tenant.currency)}</b>
              </div>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-[var(--muted)]">Transactions</span>
                <span className="tabular-nums">{salesSummary.transactions.current.toLocaleString()}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-[var(--muted)]">Units sold</span>
                <span className="tabular-nums">{salesSummary.unitsSold.current.toLocaleString()}</span>
              </div>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="text-[var(--muted)]">Average sale</span>
                <span className="tabular-nums">{formatMoney(salesSummary.averageTransactionMillis, tenant.currency)}</span>
              </div>
              {/* Purchases against revenue is a rough cost-of-goods signal.
                  It is not food cost percentage — that needs consumption
                  matched to the period, which the reports page does. */}
              {purchaseTotals.current > 0 && salesSummary.revenue.current > 0 && (
                <p className="border-t pt-3 text-xs text-[var(--muted)]">
                  Purchases were {formatPercent((purchaseTotals.current / salesSummary.revenue.current) * 100)} of revenue this period.
                </p>
              )}
            </DashboardCard>

            <DashboardCard title="Best sellers" subtitle="By revenue, at the prices actually charged" heightClassName="lg:h-[21rem]" bodyClassName="px-0 py-0 sm:px-0">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Item</TH>
                    <TH className="text-right">Units</TH>
                    <TH className="text-right">Revenue</TH>
                  </TR>
                </THead>
                <TBody>
                  {topSellers.map(item => (
                    <TR key={item.menuItemId}>
                      <TD>
                        <b className="text-sm">{item.menuItemName}</b>
                      </TD>
                      <TDNum>{item.quantity.toLocaleString()}</TDNum>
                      <TDNum className="font-semibold">{formatMoney(item.revenueMillis, tenant.currency)}</TDNum>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </DashboardCard>
          </div>
        )}
      </Section>

      {/* ------------------------------------------------------------ profitability */}
      <Section title="Profitability" description="Every dish priced against the live cost of its ingredients" action={{ label: "Open reports", href: "/dashboard/reports?report=menu" }}>
        {menuItems.length === 0 ? (
          <Card>
            <EmptyState
              icon={UtensilsCrossed}
              title="No menu items yet"
              description="Create a menu item and connect it to a recipe to start measuring profitability."
              action={{ label: "Build your menu", href: "/dashboard/menu" }}
            />
          </Card>
        ) : costedItems.length === 0 ? (
          <Card>
            <EmptyState
              icon={ChefHat}
              title="Nothing costed yet"
              description="Your menu items have no ingredients attached, so food cost and margin cannot be calculated. Add what goes into each dish to see its profit."
              action={{ label: "Open menu", href: "/dashboard/menu" }}
            />
          </Card>
        ) : (
          <div className="grid gap-5 xl:grid-cols-2">
            <DashboardCard title="Best margins" subtitle="Priced against live ingredient costs" heightClassName="lg:h-[24rem]" bodyClassName="px-0 py-0 sm:px-0">
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Item</TH>
                    <TH className="text-right">Price</TH>
                    <TH className="text-right">Cost</TH>
                    <TH className="text-right">Profit</TH>
                    <TH className="text-right">Margin</TH>
                  </TR>
                </THead>
                <TBody>
                  {topMenuItems.map(item => (
                    <TR key={item.id}>
                      <TD>
                        <b className="text-sm">{item.name}</b>
                        {item.category && <span className="block text-xs text-[var(--muted)]">{item.category}</span>}
                      </TD>
                      <TDNum>{formatMoney(item.sellingPriceMillis, tenant.currency)}</TDNum>
                      <TDNum>{formatMoney(item.economics.totalCostMillis, tenant.currency)}</TDNum>
                      <TDNum className="font-semibold text-green-800">{formatMoney(item.economics.grossProfitMillis, tenant.currency)}</TDNum>
                      <TDNum>
                        <Badge tone="success">{formatPercent(item.economics.grossMarginPercent)}</Badge>
                      </TDNum>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </DashboardCard>

            <DashboardCard title="High food cost" subtitle="Above the 35% watch line" heightClassName="lg:h-[24rem]">
              {highFoodCost.length === 0 ? (
                <EmptyState
                  icon={TrendingUp}
                  title="Every item is within range"
                  description="No costed menu item is above 35% food cost. Margins are healthy across the menu."
                  className="py-6"
                />
              ) : (
                highFoodCost.map(item => (
                  <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border border-red-200/70 bg-red-50/40 p-3">
                    <div className="min-w-0">
                      <b className="block truncate text-sm">{item.name}</b>
                      <p className="text-xs text-[var(--muted)]">
                        {formatMoney(item.economics.totalCostMillis, tenant.currency)} cost on {formatMoney(item.sellingPriceMillis, tenant.currency)}
                      </p>
                    </div>
                    <Badge tone={foodCostTone(item.economics.foodCostPercent)}>{formatPercent(item.economics.foodCostPercent)}</Badge>
                  </div>
                ))
              )}
            </DashboardCard>
          </div>
        )}
      </Section>
    </>
  );
}


function DashboardCard({
  title,
  subtitle,
  children,
  footer,
  heightClassName = "lg:h-[28rem]",
  headerClassName,
  bodyClassName,
  className,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  heightClassName?: string;
  headerClassName?: string;
  bodyClassName?: string;
  className?: string;
}) {
  return (
    <Card className={cn("flex min-h-0 flex-col overflow-hidden", heightClassName, className)}>
      <CardHeader className={cn("shrink-0 border-b", headerClassName)}>
        <h3 className="font-black">{title}</h3>
        {subtitle && <p className="text-sm text-[var(--muted)]">{subtitle}</p>}
      </CardHeader>
      <CardContent className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-3", bodyClassName)}>
        {children}
      </CardContent>
      {footer && <div className="shrink-0 border-t bg-white px-4 py-3 sm:px-5">{footer}</div>}
    </Card>
  );
}

function QuickAction({ href, icon: Icon, label }: { href: string; icon: LucideIcon; label: string }) {
  return (
    <Link href={href} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border bg-white px-3 text-sm font-semibold shadow-sm transition hover:border-green-700/40 hover:bg-green-50/40">
      <Icon size={16} className="text-green-800" />
      {label}
    </Link>
  );
}
