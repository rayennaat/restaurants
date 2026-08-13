import { AlertTriangle, CalendarX, ClipboardList } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { WasteForm } from "@/components/forms/waste-form";
import { WasteChart } from "@/components/charts/waste-chart";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { bucketLabel, resolveDateRange } from "@/lib/date-range";
import { formatMoney } from "@/lib/money";
import { formatQuantity } from "@/lib/units";
import { wasteReasonLabel } from "@/lib/waste-reasons";
import { listIngredientOptions } from "@/server/queries/ingredients";
import { getWasteSummary, getWasteTrendSeries, listRecentWaste } from "@/server/queries/analytics";
import { getOrganizationUnits, requireTenant } from "@/server/tenant";

export const metadata = { title: "Waste" };

export default async function WastePage() {
  const tenant = await requireTenant();
  // Two weeks of context, matching what this screen showed before.
  const range = resolveDateRange({ range: "custom", from: isoDaysAgo(13), to: isoDaysAgo(0) });
  const scope = { organizationId: tenant.organizationId, locationId: tenant.locationId };

  const [ingredients, units, summary, trend, entries] = await Promise.all([
    listIngredientOptions(tenant.organizationId),
    getOrganizationUnits(tenant.organizationId),
    getWasteSummary(scope, range),
    getWasteTrendSeries(scope, range, iso => bucketLabel(iso, range.granularity)),
    listRecentWaste(scope, range, 40),
  ]);

  const biggestDay = trend.reduce((worst, point) => (point.cost > worst.cost ? point : worst), { day: "—", label: "—", cost: 0 });

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Waste log"
        description="Log what gets thrown away. Each entry removes the stock and prices the loss at what that ingredient costs you, so spoilage becomes a number you can act on."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Last 14 days" value={formatMoney(summary.cost.current, tenant.currency)} hint="Total value lost" icon={AlertTriangle} />
        <StatCard
          label="Worst day"
          value={biggestDay.cost > 0 ? formatMoney(biggestDay.cost, tenant.currency) : "—"}
          hint={biggestDay.cost > 0 ? biggestDay.label : "Nothing recorded"}
          icon={CalendarX}
        />
        <StatCard label="Entries" value={String(summary.events)} hint="Recorded in the last 14 days" icon={ClipboardList} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-black">Record waste</h2>
            <p className="text-sm text-[var(--muted)]">Works offline — entries sync when you reconnect.</p>
          </CardHeader>
          <CardContent>
            {ingredients.length === 0 ? (
              <EmptyState
                icon={AlertTriangle}
                title="No ingredients yet"
                description="Waste is priced from ingredient costs, so add an ingredient before logging spoilage."
                action={{ label: "Add ingredients", href: "/dashboard/ingredients" }}
                className="py-8"
              />
            ) : tenant.locationId ? (
              <WasteForm ingredients={ingredients} units={units} locationId={tenant.locationId} />
            ) : (
              <EmptyState icon={AlertTriangle} title="No location set up" description="Waste is recorded against a location. Create one in settings first." action={{ label: "Open settings", href: "/dashboard/settings" }} className="py-8" />
            )}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <h2 className="text-lg font-black">Cost trend</h2>
              <p className="text-sm text-[var(--muted)]">Last 14 days</p>
            </CardHeader>
            <CardContent>
              {summary.cost.current === 0 ? (
                <EmptyState icon={AlertTriangle} title="Nothing logged yet" description="Record your first entry and the trend will appear here." className="py-8" />
              ) : (
                <WasteChart data={trend} currency={tenant.currency} />
              )}
            </CardContent>
          </Card>

          <Card className="overflow-hidden">
            <CardHeader>
              <h2 className="text-lg font-black">Recent entries</h2>
            </CardHeader>
            {entries.length === 0 ? (
              <EmptyState icon={AlertTriangle} title="No waste entries" description="Logged waste will show up here with its cost." className="py-8" />
            ) : (
              <Table>
                <THead>
                  <TR className="hover:bg-transparent">
                    <TH>Ingredient</TH>
                    <TH>Reason</TH>
                    <TH className="text-right">Quantity</TH>
                    <TH className="text-right">Cost</TH>
                  </TR>
                </THead>
                <TBody>
                  {entries.map(entry => (
                    <TR key={entry.id}>
                      <TD>
                        <b className="text-sm">{entry.ingredientName}</b>
                        <span className="block text-xs text-[var(--muted)]">{entry.occurredAt.toLocaleDateString()}</span>
                      </TD>
                      <TD className="text-sm">{wasteReasonLabel(entry.reason)}</TD>
                      <TDNum>{formatQuantity(entry.quantity, entry.unit)}</TDNum>
                      <TDNum className="font-semibold">{formatMoney(entry.costMillis, tenant.currency)}</TDNum>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

/** `YYYY-MM-DD` for N days before today, in UTC. */
function isoDaysAgo(days: number) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
