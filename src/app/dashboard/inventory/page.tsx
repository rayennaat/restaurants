import Link from "next/link";
import { AlertTriangle, Boxes, Coins, PackagePlus, PackageSearch, TrendingDown } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { SectionNav } from "@/components/dashboard/section-nav";
import { StatCard } from "@/components/dashboard/stat-card";
import { InventoryLocationFilter } from "@/components/inventory/inventory-location-filter";
import { InventoryTable } from "@/components/inventory/inventory-table";
import { MovementLedger } from "@/components/inventory/movement-ledger";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney } from "@/lib/money";
import { getInventory, inventoryValue, listStockMovements, lowStockRows } from "@/server/queries/inventory";
import { resolveMemberLocation } from "@/server/queries/locations";
import { requireTenant } from "@/server/tenant";

export const metadata = { title: "Inventory" };

export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ location?: string | string[] }> }) {
  const tenant = await requireTenant();
  const params = await searchParams;
  const requestedLocation = Array.isArray(params.location) ? params.location[0] : params.location;
  const location = await resolveMemberLocation(tenant, requestedLocation);
  // `null` means all locations for organization-wide roles. An unassigned
  // site-bound member instead gets a sentinel so this page fails closed.
  const inventoryLocationId = location.options.length === 0 ? "__no_assigned_location__" : location.id;
  const [inventory, movements] = await Promise.all([
    getInventory(tenant.organizationId, inventoryLocationId),
    listStockMovements(tenant.organizationId, { locationId: inventoryLocationId, limit: 25 }),
  ]);

  const lowStock = lowStockRows(inventory);
  const outOfStock = inventory.filter(row => row.stock <= 0);

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Inventory"
        description="What you hold right now, and what it is worth. Every balance is built from the purchases, sales, waste and counts you record — never typed in by hand."
        action={
          <Link href="/dashboard/purchases?view=new">
            <Button>
              <PackagePlus size={17} /> Receive purchase
            </Button>
          </Link>
        }
      />

      <SectionNav />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-white px-3 py-2 shadow-sm">
        <p className="text-sm text-[var(--muted)]">
          {inventory.length} active ingredient{inventory.length === 1 ? "" : "s"} · {location.name}
        </p>
        <InventoryLocationFilter locations={location.options} currentLocationId={location.id} />
      </div>

      {inventory.length === 0 ? (
        <Card>
          <EmptyState
            icon={Boxes}
            title="Nothing in stock yet"
            description="Add the ingredients you buy, then record a supplier invoice. Stock levels build themselves from the movements you record."
            action={{ label: "Add ingredients", href: "/dashboard/ingredients" }}
            secondaryAction={{ label: "Record a purchase", href: "/dashboard/purchases?view=new" }}
          />
        </Card>
      ) : (
        <>
          {(outOfStock.length > 0 || lowStock.length > 0) && (
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-950">
              <p className="inline-flex items-center gap-2">
                <AlertTriangle size={16} />
                <b>{outOfStock.length} out of stock</b>
                <span>·</span>
                <b>{lowStock.length} below minimum</b>
              </p>
              <Link href="/dashboard/purchases?view=new" className="font-semibold text-green-900 hover:underline">Receive purchase</Link>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="Stock on hand" value={formatMoney(inventoryValue(inventory), tenant.currency)} hint={`${inventory.length} active ingredient${inventory.length === 1 ? "" : "s"} · ${location.name}`} icon={Coins} />
            <StatCard label="Below minimum" value={String(lowStock.length)} hint={`Reorder these first · ${location.name}`} icon={PackageSearch} />
            <StatCard label="Out of stock" value={String(outOfStock.length)} hint={`Zero or negative balance · ${location.name}`} icon={TrendingDown} />
          </div>

          <div className="mt-5 grid items-start gap-5 xl:grid-cols-[2fr_.9fr]">
            <Card className="overflow-hidden xl:flex xl:max-h-[53rem] xl:flex-col xl:self-start">
              <CardHeader className="flex flex-wrap items-start justify-between gap-3 border-b">
                <div>
                  <h2 className="text-lg font-black">Ingredient balances</h2>
                  <p className="text-sm text-[var(--muted)]">Valued at each ingredient&apos;s latest known unit cost.</p>
                </div>
                <span className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Low and out rows are highlighted</span>
              </CardHeader>
              <div className="scrollbar-thin xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:overscroll-contain">
                <InventoryTable data={inventory} currency={tenant.currency} />
              </div>
            </Card>

            <Card className="overflow-hidden xl:max-h-[53rem] xl:self-start">
              <CardHeader className="border-b bg-white">
                <h2 className="text-lg font-black">Recent movements</h2>
                <p className="text-sm text-[var(--muted)]">Everything that moved this stock in or out.</p>
              </CardHeader>
              <MovementLedger rows={movements} currency={tenant.currency} />
            </Card>
          </div>
        </>
      )}
    </>
  );
}
