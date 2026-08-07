import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Mail, MapPin, PackagePlus, Phone, User } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatCard } from "@/components/dashboard/stat-card";
import { SupplierPriceHistory } from "@/components/suppliers/supplier-price-history";
import { SupplierProductTable } from "@/components/suppliers/supplier-product-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Coins, Package, Receipt } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { listIngredientOptions } from "@/server/queries/ingredients";
import { getSupplier, getSupplierPriceHistory, listSupplierProducts, listSuppliers } from "@/server/queries/suppliers";
import { can, getOrganizationUnits, requireTenant } from "@/server/tenant";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const tenant = await requireTenant();
  const supplier = await getSupplier(tenant.organizationId, (await params).id);
  return { title: supplier?.name ?? "Supplier" };
}

export default async function SupplierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await requireTenant();

  const supplier = await getSupplier(tenant.organizationId, id);
  if (!supplier) notFound();

  const [products, history, ingredients, units, summary] = await Promise.all([
    listSupplierProducts(tenant.organizationId, id),
    getSupplierPriceHistory(tenant.organizationId, id, { limit: 60 }),
    listIngredientOptions(tenant.organizationId),
    getOrganizationUnits(tenant.organizationId),
    listSuppliers(tenant.organizationId, { status: "all" }).then(rows => rows.find(row => row.id === id)),
  ]);

  return (
    <>
      <Link href="/dashboard/suppliers" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--muted)] transition hover:text-green-800">
        <ArrowLeft size={16} /> All suppliers
      </Link>

      <PageHeader
        eyebrow="Supplier"
        title={supplier.name}
        description={supplier.notes ?? "Products, current prices and every price change recorded from your invoices."}
        action={
          <Link href={`/dashboard/purchases?view=new&supplierId=${supplier.id}`}>
            <Button>
              <PackagePlus size={17} /> New invoice
            </Button>
          </Link>
        }
      />

      {!supplier.isActive && (
        <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
          This supplier is archived. It stays out of pickers but its history is preserved.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total spend" value={formatMoney(summary?.totalSpendMillis ?? 0, tenant.currency)} hint={`${summary?.purchaseCount ?? 0} received invoices`} icon={Coins} />
        <StatCard label="Products listed" value={String(products.length)} hint="Items in their catalog" icon={Package} />
        <StatCard label="Price points" value={String(history.length)} hint="Invoice lines on record" icon={Receipt} />
      </div>

      {(supplier.contactName || supplier.phone || supplier.email || supplier.address) && (
        <Card className="mt-6">
          <CardContent className="flex flex-wrap gap-x-8 gap-y-3 pt-5 text-sm">
            {supplier.contactName && (
              <span className="inline-flex items-center gap-2">
                <User size={16} className="text-[var(--muted)]" /> {supplier.contactName}
              </span>
            )}
            {supplier.phone && (
              <a href={`tel:${supplier.phone}`} className="inline-flex items-center gap-2 font-semibold text-green-800 hover:underline">
                <Phone size={16} /> {supplier.phone}
              </a>
            )}
            {supplier.email && (
              <a href={`mailto:${supplier.email}`} className="inline-flex items-center gap-2 font-semibold text-green-800 hover:underline">
                <Mail size={16} /> {supplier.email}
              </a>
            )}
            {supplier.address && (
              <span className="inline-flex items-center gap-2 text-[var(--muted)]">
                <MapPin size={16} /> {supplier.address}
              </span>
            )}
          </CardContent>
        </Card>
      )}

      <div className="mt-6 space-y-6">
        <SupplierProductTable
          supplierId={supplier.id}
          rows={products}
          ingredients={ingredients}
          units={units}
          currency={tenant.currency}
          canManage={can(tenant.role, "manage_catalog")}
        />
        <SupplierPriceHistory points={history} currency={tenant.currency} />
      </div>
    </>
  );
}
