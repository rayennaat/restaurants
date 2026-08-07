import { redirect } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Coins, PackageSearch, TrendingUp } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { WasteChart } from "@/components/charts/waste-chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { averageMargin } from "@/lib/costing";
import { formatMoney, formatPercent } from "@/lib/money";
import { formatQuantity } from "@/lib/units";
import { getInventory, getWasteTrend, inventoryValue, lowStockRows } from "@/server/queries/inventory";
import { listMenuItems } from "@/server/queries/menu";
import { getSetupProgress } from "@/server/queries/onboarding";
import { getOrganizationUnits, requireTenant } from "@/server/tenant";

export const metadata = { title: "Overview" };

export default async function DashboardPage() {
  const tenant = await requireTenant();

  // Until the guided setup is finished, the checklist is the dashboard.
  const setup = await getSetupProgress(tenant.organizationId);
  if (!tenant.onboardingCompletedAt && !setup.allStepsComplete) redirect("/onboarding");

  const units = await getOrganizationUnits(tenant.organizationId);
  const [inventory, wasteTrend, menuItems] = await Promise.all([
    getInventory(tenant.organizationId, tenant.locationId),
    getWasteTrend(tenant.organizationId, 7),
    listMenuItems(tenant.organizationId, units, { status: "active" }),
  ]);

  const lowStock = lowStockRows(inventory);
  const weeklyWaste = wasteTrend.reduce((total, point) => total + point.cost, 0);
  const costedItems = menuItems.filter(item => item.economics.isCosted);
  const margin = averageMargin(costedItems.map(item => ({ sellingPriceMillis: item.sellingPriceMillis, totalCostMillis: item.economics.totalCostMillis })));

  return (
    <>
      <PageHeader eyebrow="Today" title="Operations overview" description="Know what changed, what is at risk, and where profit is leaking." />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Inventory value" value={formatMoney(inventoryValue(inventory), tenant.currency)} hint={`${inventory.length} active ingredients`} icon={Coins} />
        <StatCard label="Weekly waste" value={formatMoney(weeklyWaste, tenant.currency)} hint="Last seven days" icon={AlertTriangle} />
        <StatCard label="Low-stock items" value={String(lowStock.length)} hint="Below minimum level" icon={PackageSearch} />
        <StatCard
          label="Average margin"
          value={costedItems.length ? formatPercent(margin) : "—"}
          hint={costedItems.length ? `Across ${costedItems.length} costed menu items` : "Link recipes to menu items"}
          icon={TrendingUp}
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-black">Waste cost trend</h2>
            <p className="text-sm text-[var(--muted)]">Daily estimated ingredient value lost</p>
          </CardHeader>
          <CardContent>
            {weeklyWaste === 0 ? (
              <EmptyState
                icon={AlertTriangle}
                title="No waste recorded this week"
                description="Either a great week, or waste is not being logged yet. Recording it is what turns spoilage into a number you can act on."
                action={{ label: "Record waste", href: "/dashboard/waste" }}
                className="py-8"
              />
            ) : (
              <WasteChart data={wasteTrend} currency={tenant.currency} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-lg font-black">Stock attention</h2>
            <p className="text-sm text-[var(--muted)]">Items nearest to a stockout</p>
          </CardHeader>
          <CardContent className="space-y-3">
            {inventory.length === 0 ? (
              <EmptyState icon={PackageSearch} title="No stock tracked yet" description="Receive a purchase invoice to start tracking balances." action={{ label: "Receive purchase", href: "/dashboard/purchases" }} className="py-6" />
            ) : (
              <>
                {[...inventory]
                  .sort((a, b) => (a.minimum > 0 ? a.stock / a.minimum : Infinity) - (b.minimum > 0 ? b.stock / b.minimum : Infinity))
                  .slice(0, 6)
                  .map(item => (
                    <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                      <div className="min-w-0">
                        <b className="block truncate text-sm">{item.name}</b>
                        <p className="text-xs text-[var(--muted)]">
                          {formatQuantity(item.stock, item.unit)} {item.minimum > 0 && `/ min ${formatQuantity(item.minimum, item.unit)}`}
                        </p>
                      </div>
                      <Badge tone={item.stock <= 0 ? "danger" : item.stock < item.minimum ? "warning" : "success"}>
                        {item.stock <= 0 ? "Out" : item.stock < item.minimum ? "Order" : "OK"}
                      </Badge>
                    </div>
                  ))}
                <Link href="/dashboard/inventory">
                  <Button variant="secondary" className="w-full">
                    View full inventory <ArrowRight size={16} />
                  </Button>
                </Link>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
