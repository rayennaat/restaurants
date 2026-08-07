import { PageHeader } from "@/components/dashboard/page-header";
import { SupplierComparison } from "@/components/suppliers/supplier-comparison";
import { SupplierDirectory } from "@/components/suppliers/supplier-directory";
import { getSupplierComparison, listSuppliers } from "@/server/queries/suppliers";
import { can, requireTenant } from "@/server/tenant";

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
        eyebrow="Purchasing"
        title="Suppliers"
        description="Who you buy from, what they sell you and what you last paid. Prices refresh themselves every time you record an invoice."
      />
      <SupplierDirectory rows={rows} currency={tenant.currency} canManage={can(tenant.role, "manage_catalog")} isEmptyDirectory={totalCount === 0} />
      {comparison.length > 0 && (
        <div className="mt-8">
          <SupplierComparison rows={comparison} currency={tenant.currency} />
        </div>
      )}
    </>
  );
}
