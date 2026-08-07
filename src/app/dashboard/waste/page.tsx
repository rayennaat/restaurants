import { AlertTriangle, CalendarX, ClipboardList } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { WasteForm } from "@/components/forms/waste-form";
import { WasteChart } from "@/components/charts/waste-chart";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import { formatQuantity } from "@/lib/units";
import { listIngredientOptions } from "@/server/queries/ingredients";
import { getWasteTrend, listStockMovements } from "@/server/queries/inventory";
import { getOrganizationUnits, requireTenant } from "@/server/tenant";

export const metadata = { title: "Waste" };

const reasonLabels: Record<string, string> = {
  expired: "Expired",
  damaged: "Damaged",
  overproduction: "Overproduction",
  preparation_error: "Preparation error",
  quality_issue: "Quality issue",
  other: "Other",
};

export default async function WastePage() {
  const tenant = await requireTenant();

  const [ingredients, units, trend, movements] = await Promise.all([
    listIngredientOptions(tenant.organizationId),
    getOrganizationUnits(tenant.organizationId),
    getWasteTrend(tenant.organizationId, 14),
    listStockMovements(tenant.organizationId, { locationId: tenant.locationId, limit: 40 }),
  ]);

  const wasteMovements = movements.filter(movement => movement.type === "waste");
  const totalCost = trend.reduce((sum, point) => sum + point.cost, 0);
  const biggestDay = trend.reduce((worst, point) => (point.cost > worst.cost ? point : worst), { day: "—", cost: 0 });

  return (
    <>
      <PageHeader
        eyebrow="Control"
        title="Waste log"
        description="Every entry deducts real stock and prices the loss at the ingredient's current cost, so spoilage becomes a number you can act on."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Last 14 days" value={formatMoney(totalCost, tenant.currency)} hint="Total value lost" icon={AlertTriangle} />
        <StatCard label="Worst day" value={biggestDay.cost > 0 ? formatMoney(biggestDay.cost, tenant.currency) : "—"} hint={biggestDay.cost > 0 ? biggestDay.day : "Nothing recorded"} icon={CalendarX} />
        <StatCard label="Entries" value={String(wasteMovements.length)} hint="Recent waste records" icon={ClipboardList} />
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
              {totalCost === 0 ? (
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
            {wasteMovements.length === 0 ? (
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
                  {wasteMovements.map(movement => (
                    <TR key={movement.id}>
                      <TD>
                        <b className="text-sm">{movement.ingredientName}</b>
                        <span className="block text-xs text-[var(--muted)]">{movement.occurredAt.toLocaleDateString()}</span>
                      </TD>
                      <TD className="text-sm">{reasonLabels[movement.note ?? ""] ?? movement.note ?? "—"}</TD>
                      <TDNum>{formatQuantity(Math.abs(movement.quantity), movement.unit)}</TDNum>
                      <TDNum className="font-semibold">{formatMoney(Math.abs(movement.quantity) * movement.unitCostMillis, tenant.currency)}</TDNum>
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
