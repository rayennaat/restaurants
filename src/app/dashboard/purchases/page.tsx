import Link from "next/link";
import { PackagePlus } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { SectionNav } from "@/components/dashboard/section-nav";
import { PurchaseInvoiceBuilder } from "@/components/forms/purchase-invoice-builder";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { TabNav } from "@/components/ui/tab-nav";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/utils";
import { listIngredientOptions } from "@/server/queries/ingredients";
import { listPurchases } from "@/server/queries/purchases";
import { listSupplierOptions, listSupplierProductLookup } from "@/server/queries/suppliers";
import { resolveMemberLocation } from "@/server/queries/locations";
import { getOrganizationUnits, hasPermission, requireTenant } from "@/server/tenant";

export const metadata = { title: "Purchases" };

export default async function PurchasesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Require at least a tenant — the invoice builder itself needs a location
  // because every purchase posts against one, but the list should still load.
  const tenant = await requireTenant();

  const params = await searchParams;
  const canPurchase = hasPermission(tenant.role, "manage_purchasing");
  const view = params.view === "list" || !canPurchase ? "list" : "new";
  const defaultSupplierId = typeof params.supplierId === "string" ? params.supplierId : undefined;
  const location = await resolveMemberLocation(tenant, undefined);
  const locs = location.options.filter(option => option.isActive).map(option => ({ id: option.id, name: option.name }));

  const [purchases, ingredients, suppliers, products, units] = await Promise.all([
    listPurchases(tenant.organizationId, { locationId: location.id, limit: 30 }),
    listIngredientOptions(tenant.organizationId),
    listSupplierOptions(tenant.organizationId),
    listSupplierProductLookup(tenant.organizationId),
    getOrganizationUnits(tenant.organizationId),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Purchases"
        title="Purchases"
        description="Record the invoices you receive from suppliers. Each line adds stock, updates that ingredient's cost, and remembers the price your supplier charged."
        action={
          canPurchase ? (
            <Link
              href={view === "new" ? "?view=list" : "?view=new"}
              className={
                view === "new"
                  ? "inline-flex h-10 items-center rounded-lg border bg-white px-3.5 text-sm font-semibold transition hover:bg-neutral-50"
                  : "inline-flex h-10 items-center rounded-lg bg-[var(--primary)] px-3.5 text-sm font-semibold text-white transition hover:bg-green-800"
              }
            >
              {view === "new" ? "Purchase history" : "New invoice"}
            </Link>
          ) : undefined
        }
      />

      <SectionNav />

      <TabNav
        label="Purchase view"
        className="mb-5"
        items={[
          { label: "Purchase history", href: "?view=list", current: view === "list" },
          ...(canPurchase ? [{ label: "New invoice", href: "?view=new", current: view === "new" }] : []),
        ]}
      />

      {view === "new" ? (
        locs.length === 0 ? (
          <Card>
            <EmptyState
              icon={PackagePlus}
              title="No active location"
              description="Create a location in Settings first. Every purchase must be recorded against one."
              action={{ label: "Open settings", href: "/dashboard/settings" }}
            />
          </Card>
        ) : (
          <div className="w-full space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50/60 px-4 py-3 text-sm text-green-950">
              <p>
                <b>Receiving stock now.</b> Choose supplier, confirm location, add invoice lines, then receive once to update stock and costs.
              </p>
              <Link href="?view=list" className="font-semibold text-green-900 hover:underline">
                Purchase history
              </Link>
            </div>
            <PurchaseInvoiceBuilder
              locations={locs}
              suppliers={suppliers}
              ingredients={ingredients}
              products={products}
              units={units}
              currency={tenant.currency}
              defaultSupplierId={defaultSupplierId}
            />
          </div>
        )
      ) : purchases.length === 0 ? (
        <Card>
          <EmptyState
            icon={PackagePlus}
            title="No purchases recorded yet"
            description="Record your first supplier invoice — this is the primary way inventory enters the system and ingredient costs get populated."
            action={{ label: "Record first invoice", href: "?view=new" }}
          />
        </Card>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
          <Table className="min-w-[800px]">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Date</TH>
                <TH>Supplier</TH>
                <TH className="text-right">Amount</TH>
                <TH>Location</TH>
                <TH>Lines</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {purchases.map(row => (
                <TR key={row.id}>
                  <TD>
                    <Link href={`/dashboard/purchases/${row.id}`} className="font-semibold hover:text-green-800">
                      {formatDate(row.receivedAt)}
                    </Link>
                    {row.invoiceNumber && <span className="block text-xs text-[var(--muted)]">#{row.invoiceNumber}</span>}
                  </TD>
                  <TD className="text-[var(--muted)]">{row.supplierName ?? "—"}</TD>
                  <TDNum className="font-semibold">{formatMoney(row.totalMillis, tenant.currency)}</TDNum>
                  <TD className="text-[var(--muted)]">{row.locationName}</TD>
                  <TD className="tabular-nums">{row.itemCount}</TD>
                  <TD>
                    {row.status === "received" ? <Badge tone="success">Received</Badge> : row.status === "draft" ? <Badge>Draft</Badge> : <Badge tone="danger">Cancelled</Badge>}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </>
  );
}
