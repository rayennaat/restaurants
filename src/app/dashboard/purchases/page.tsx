import Link from "next/link";
import { PackagePlus } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { PurchaseInvoiceBuilder } from "@/components/forms/purchase-invoice-builder";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/money";
import { formatDate } from "@/lib/utils";
import { listIngredientOptions } from "@/server/queries/ingredients";
import { listPurchases } from "@/server/queries/purchases";
import { listSupplierOptions, listSupplierProductLookup } from "@/server/queries/suppliers";
import { getOrganizationUnits, requireTenantLocation, requireTenant } from "@/server/tenant";
import { and, eq } from "drizzle-orm";
import { locations } from "@/db/schema";
import { getDb } from "@/db/client";

export const metadata = { title: "Purchases" };

export default async function PurchasesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Require at least a tenant — the invoice builder itself needs a location
  // because every purchase posts against one, but the list should still load.
  const tenant = await requireTenant();

  const params = await searchParams;
  const view = params.view === "list" ? "list" : "new";
  const defaultSupplierId = typeof params.supplierId === "string" ? params.supplierId : undefined;

  const db = getDb();
  const locs = await db
    .select({ id: locations.id, name: locations.name })
    .from(locations)
    .where(and(eq(locations.organizationId, tenant.organizationId), eq(locations.isActive, true)));

  const [purchases, ingredients, suppliers, products, units] = await Promise.all([
    listPurchases(tenant.organizationId, { locationId: tenant.locationId, limit: 30 }),
    listIngredientOptions(tenant.organizationId),
    listSupplierOptions(tenant.organizationId),
    listSupplierProductLookup(tenant.organizationId),
    getOrganizationUnits(tenant.organizationId),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Receiving"
        title="Purchases"
        description="Record real supplier invoices. Each line updates stock, ingredient cost and supplier pricing in one atomic transaction."
        action={
          <div className="flex gap-2">
            <Link href="?view=list">
              <Button variant={view === "list" ? "secondary" : "ghost"} size="sm">
                Purchase history
              </Button>
            </Link>
            <Link href="?view=new">
              <Button variant={view === "new" ? "secondary" : "ghost"} size="sm">
                New invoice
              </Button>
            </Link>
          </div>
        }
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
          <div className="max-w-4xl">
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
        <div className="overflow-hidden rounded-2xl border bg-white panel-shadow">
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
