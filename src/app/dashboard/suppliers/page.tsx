import { Package, ReceiptText } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { SectionNav } from "@/components/dashboard/section-nav";
import { SupplierComparison } from "@/components/suppliers/supplier-comparison";
import { SupplierDirectory } from "@/components/suppliers/supplier-directory";
import { getSupplierComparison, listSuppliers } from "@/server/queries/suppliers";
import { hasPermission, requireTenant } from "@/server/tenant";

export const metadata = { title: "Suppliers" };

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const tenant = await requireTenant();
  const params = await searchParams;

  const q = typeof params.q === "string" ? params.q : undefined;
  const status = params.status === "archived" || params.status === "all" ? params.status : "active";

  const [rows, totalCount, comparison] = await Promise.all([
    listSuppliers(tenant.organizationId, { q, status }),
    listSuppliers(tenant.organizationId, { status: "all" }).then(all => all.length),
    getSupplierComparison(tenant.organizationId),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Purchases"
        title="Suppliers"
        description="Who you buy from, what they sell you and what you last paid. Prices refresh themselves every time you record an invoice."
      />

      <SectionNav />

      {totalCount > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Suppliers</p>
            <p className="mt-1 text-2xl font-black tabular-nums">{rows.length}</p>
          </div>
          <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]"><Package size={13} /> Products</p>
            <p className="mt-1 text-2xl font-black tabular-nums">{rows.reduce((total, row) => total + row.productCount, 0)}</p>
          </div>
          <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]"><ReceiptText size={13} /> Price points</p>
            <p className="mt-1 text-2xl font-black tabular-nums text-green-900">{rows.reduce((total, row) => total + row.pricePointCount, 0)}</p>
          </div>
        </div>
      )}

      <SupplierDirectory rows={rows} currency={tenant.currency} canManage={hasPermission(tenant.role, "manage_suppliers")} isEmptyDirectory={totalCount === 0} />
      {comparison.length > 0 && (
        <div className="mt-5">
          <SupplierComparison rows={comparison} currency={tenant.currency} />
        </div>
      )}
    </>
  );
}
