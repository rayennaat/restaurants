import Link from "next/link";
import { Boxes, Coins, PackagePlus, PackageSearch, TrendingDown } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { SectionNav } from "@/components/dashboard/section-nav";
import { StatCard } from "@/components/dashboard/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { InventoryTable } from "@/components/inventory/inventory-table";
import { MovementLedger } from "@/components/inventory/movement-ledger";
import { formatMoney } from "@/lib/money";
import { getInventory, inventoryValue, listStockMovements, lowStockRows } from "@/server/queries/inventory";
import { requireTenant } from "@/server/tenant";

export const metadata = { title: "Inventory" };

export default async function InventoryPage() {
  const tenant = await requireTenant();
  const [inventory, movements] = await Promise.all([
    getInventory(tenant.organizationId, tenant.locationId),
    listStockMovements(tenant.organizationId, { locationId: tenant.locationId, limit: 25 }),
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
          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Stock on hand" value={formatMoney(inventoryValue(inventory), tenant.currency)} hint={`${inventory.length} active ingredients`} icon={Coins} />
            <StatCard label="Below minimum" value={String(lowStock.length)} hint="Reorder these first" icon={PackageSearch} />
            <StatCard label="Out of stock" value={String(outOfStock.length)} hint="Zero or negative balance" icon={TrendingDown} />
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-[1.5fr_1fr]">
            <Card className="overflow-hidden">
              <CardHeader>
                <h2 className="text-lg font-black">Ingredient balances</h2>
                <p className="text-sm text-[var(--muted)]">Valued at each ingredient&apos;s latest known unit cost.</p>
              </CardHeader>
              <InventoryTable data={inventory} currency={tenant.currency} />
            </Card>

            <Card className="overflow-hidden">
              <CardHeader>
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
