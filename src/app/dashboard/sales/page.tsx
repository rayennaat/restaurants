import Link from "next/link";
import { Coins, FileUp, Receipt, ShoppingBag, TrendingUp, UtensilsCrossed } from "lucide-react";
import { AnalyticsFilters } from "@/components/dashboard/analytics-filters";
import { KpiCard } from "@/components/dashboard/kpi-card";
import { PageHeader } from "@/components/dashboard/page-header";
import { SectionNav } from "@/components/dashboard/section-nav";
import { RecordSaleButton } from "@/components/sales/record-sale-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { bucketLabel } from "@/lib/date-range";
import { formatMoney } from "@/lib/money";
import { getAnalyticsContext, type AnalyticsSearchParams } from "@/server/analytics-context";
import { listMenuItems } from "@/server/queries/menu";
import {
  getSalesByLocation,
  getSalesByMenuItem,
  getSalesSummary,
  getSalesTrend,
  hasAnySales,
  listSales,
} from "@/server/queries/sales";
import { getOrganizationUnits, hasPermission } from "@/server/tenant";

export const metadata = { title: "Sales" };

const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  csv_import: "CSV",
  pos_import: "POS",
};

/**
 * Sales overview.
 *
 * Every figure is read from recorded sales at their snapshotted prices — no
 * projection, no menu-price arithmetic. Reading is open to any member; recording
 * requires `manage_sales`, enforced in the server action rather than by hiding
 * the button.
 */
export default async function SalesPage({ searchParams }: { searchParams: Promise<AnalyticsSearchParams> }) {
  const params = await searchParams;
  const { tenant, range, location, scope, fromInput, toInput } = await getAnalyticsContext(params);

  const canRecord = hasPermission(tenant.role, "manage_sales");
  const multiLocation = location.options.length > 1;

  const [summary, topItems, trend, byLocation, recent, everSold, units] = await Promise.all([
    getSalesSummary(scope, range),
    getSalesByMenuItem(scope, range, 10),
    getSalesTrend(scope, range, iso => bucketLabel(iso, range.granularity)),
    multiLocation ? getSalesByLocation(scope, range) : Promise.resolve([]),
    listSales(scope, range, 15),
    hasAnySales(tenant.organizationId),
    getOrganizationUnits(tenant.organizationId),
  ]);

  const menuItems = canRecord ? await listMenuItems(tenant.organizationId, units, { status: "active" }) : [];
  const periodHint = `${range.label} · ${location.name}`;
  const peak = Math.max(...trend.map(point => point.revenueMillis), 0);

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Sales"
        description="What you actually sold, at the prices you sold it for. Sales drive your revenue, your food cost, and how much stock your menu should have used."
        action={
          canRecord ? (
            <div className="flex flex-wrap items-center gap-2">
              <RecordSaleButton locations={location.options} menuItems={menuItems.map(item => ({ id: item.id, name: item.name, sellingPriceMillis: item.sellingPriceMillis }))} currency={tenant.currency} defaultLocationId={location.id ?? location.options[0]?.id} />
              <Link
                href="/dashboard/sales/import"
                className="inline-flex h-10 items-center gap-2 rounded-lg border bg-white px-3.5 text-sm font-semibold transition hover:bg-neutral-50"
              >
                <FileUp size={16} /> Import CSV
              </Link>
            </div>
          ) : undefined
        }
      />

      <SectionNav />


      <AnalyticsFilters
        locations={location.options}
        currentPreset={range.preset}
        currentLocationId={location.id}
        from={fromInput}
        to={toInput}
        className="mb-6"
      />

      {!everSold ? (
        <Card>
          <EmptyState
            icon={Receipt}
            title="No sales recorded yet"
            description={
              canRecord && menuItems.length === 0
                ? "A sale is recorded against a menu item, so build your menu first. After that you can record sales by hand or import them from your till."
                : "Record your first sale to start measuring revenue, food cost and how much stock your menu should be consuming."
            }
            // The two ways in, offered where the user first needs them rather
            // than only in the page header. With no menu yet the record button
            // would be disabled, so the empty state points at the real first
            // step instead of a control that cannot be used.
            action={
              !canRecord ? undefined : menuItems.length === 0 ? (
                { label: "Build your menu", href: "/dashboard/menu" }
              ) : (
                <RecordSaleButton
                  locations={location.options}
                  menuItems={menuItems.map(item => ({ id: item.id, name: item.name, sellingPriceMillis: item.sellingPriceMillis }))}
                  currency={tenant.currency}
                  defaultLocationId={location.id ?? location.options[0]?.id}
                />
              )
            }
            secondaryAction={canRecord && menuItems.length > 0 ? { label: "Import sales", href: "/dashboard/sales/import" } : undefined}
          />
          {!canRecord && (
            <CardContent className="pt-0 text-center text-sm text-[var(--muted)]">
              Your role can view sales but not record them.
            </CardContent>
          )}
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Revenue"
              value={formatMoney(summary.revenue.current, tenant.currency)}
              hint={summary.revenue.changePercent === null ? periodHint : `vs previous period · ${periodHint}`}
              icon={Coins}
              change={summary.revenue.changePercent}
              emphasis={summary.revenue.current > 0 ? "success" : "neutral"}
            />
            <KpiCard
              label="Transactions"
              value={String(summary.transactions.current)}
              hint={summary.transactions.current > 0 ? `${formatMoney(summary.averageTransactionMillis, tenant.currency)} average` : periodHint}
              icon={Receipt}
              change={summary.transactions.changePercent}
            />
            <KpiCard
              label="Units sold"
              value={summary.unitsSold.current.toLocaleString()}
              hint={summary.distinctMenuItems > 0 ? `Across ${summary.distinctMenuItems} menu item${summary.distinctMenuItems === 1 ? "" : "s"}` : periodHint}
              icon={ShoppingBag}
              change={summary.unitsSold.changePercent}
            />
            <KpiCard
              label="Average price"
              value={summary.unitsSold.current > 0 ? formatMoney(summary.averageUnitPriceMillis, tenant.currency) : "—"}
              hint={summary.unitsSold.current > 0 ? "Revenue per unit sold" : "Needs at least one sale"}
              icon={TrendingUp}
            />
          </div>

          {summary.transactions.current === 0 ? (
            <Card className="mt-8">
              <EmptyState
                icon={Receipt}
                title="No sales in this period"
                description="There are sales on record, but none in the selected date range. Try widening the filter above."
                className="py-8"
              />
            </Card>
          ) : (
            <>
              {/* ----------------------------------------------------- recent */}
              <section className="mt-5">
                <Card className="overflow-hidden">
                  <CardHeader className="flex flex-wrap items-start justify-between gap-3 border-b">
                    <div>
                      <h2 className="text-lg font-black">Recent sales</h2>
                      <p className="text-sm text-[var(--muted)]">
                        Voided sales stay listed so the record stays explicable — they are excluded from every figure above.
                      </p>
                    </div>
                    <Link href="/dashboard/sales/import" className="text-sm font-semibold text-green-900 hover:underline">Import CSV</Link>
                  </CardHeader>
                  <Table className="min-w-[760px]">
                    <THead>
                      <TR className="hover:bg-transparent">
                        <TH>Sale</TH>
                        <TH>Location</TH>
                        <TH>Source</TH>
                        <TH>When</TH>
                        <TH className="text-right">Lines</TH>
                        <TH className="text-right">Total</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {recent.map(sale => (
                        <TR key={sale.id}>
                          <TD>
                            <Link href={`/dashboard/sales/${sale.id}`} className="font-bold text-green-900 hover:underline">
                              {sale.reference ?? `Sale ${sale.id.slice(0, 8)}`}
                            </Link>
                            {sale.status === "voided" && (
                              <Badge tone="danger" className="ml-2">
                                Voided
                              </Badge>
                            )}
                          </TD>
                          <TD className="text-sm text-[var(--muted)]">{sale.locationName}</TD>
                          <TD className="text-sm text-[var(--muted)]">{SOURCE_LABELS[sale.source] ?? sale.source}</TD>
                          <TD className="text-sm text-[var(--muted)]">{sale.soldAt.toLocaleString()}</TD>
                          <TDNum>{sale.lineCount}</TDNum>
                          <TDNum className={sale.status === "voided" ? "text-[var(--muted)] line-through" : "font-semibold"}>
                            {formatMoney(sale.totalMillis, tenant.currency)}
                          </TDNum>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </Card>
              </section>

              {/* ------------------------------------------------------- trend */}
              <section className="mt-8">
                <Card>
                  <CardHeader>
                    <h2 className="text-lg font-black">Revenue over time</h2>
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
                            // Width is a share of the period's own peak, so the
                            // shape of the week is readable at any scale.
                            style={{ width: peak > 0 ? `${Math.max((point.revenueMillis / peak) * 100, point.revenueMillis > 0 ? 2 : 0)}%` : "0%" }}
                          />
                        </span>
                        <span className="w-28 shrink-0 text-right text-sm tabular-nums">
                          {formatMoney(point.revenueMillis, tenant.currency)}
                        </span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              </section>

              {/* -------------------------------------------- top sellers + sites */}
              <section className="mt-6 grid gap-5 xl:grid-cols-2">
                <Card className="overflow-hidden">
                  <CardHeader>
                    <h2 className="text-lg font-black">Top selling items</h2>
                    <p className="text-sm text-[var(--muted)]">By revenue · {periodHint}</p>
                  </CardHeader>
                  {topItems.length === 0 ? (
                    <CardContent>
                      <EmptyState icon={UtensilsCrossed} title="Nothing sold yet" description="Menu items appear here once they sell." className="py-6" />
                    </CardContent>
                  ) : (
                    <Table>
                      <THead>
                        <TR className="hover:bg-transparent">
                          <TH>Item</TH>
                          <TH className="text-right">Units</TH>
                          <TH className="text-right">Avg price</TH>
                          <TH className="text-right">Revenue</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {topItems.map(item => (
                          <TR key={item.menuItemId}>
                            <TD>
                              <b className="text-sm">{item.menuItemName}</b>
                            </TD>
                            <TDNum>{item.quantity.toLocaleString()}</TDNum>
                            <TDNum className="text-[var(--muted)]">{formatMoney(item.averagePriceMillis, tenant.currency)}</TDNum>
                            <TDNum className="font-semibold">{formatMoney(item.revenueMillis, tenant.currency)}</TDNum>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  )}
                </Card>

                {multiLocation && (
                  <Card className="overflow-hidden">
                    <CardHeader>
                      <h2 className="text-lg font-black">Sales by location</h2>
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
                            <TDNum>{row.transactions}</TDNum>
                            <TDNum>{row.unitsSold.toLocaleString()}</TDNum>
                            <TDNum className="font-semibold">{formatMoney(row.revenueMillis, tenant.currency)}</TDNum>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </Card>
                )}
              </section>

            </>
          )}
        </>
      )}
    </>
  );
}
