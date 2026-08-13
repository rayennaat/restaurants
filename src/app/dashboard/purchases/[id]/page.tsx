import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import { formatQuantity } from "@/lib/units";
import { formatDate, formatDateTime } from "@/lib/utils";
import { getPurchase } from "@/server/queries/purchases";
import { canAccessAllLocations, requireTenant } from "@/server/tenant";

export const dynamic = "force-dynamic";

async function PurchaseDetail({ id }: { id: string }) {
  const tenant = await requireTenant();
  const purchase = await getPurchase(tenant.organizationId, id);
  if (!purchase) notFound();
  if (!canAccessAllLocations(tenant.role) && tenant.locationId !== purchase.locationId) notFound();
  return { purchase, currency: tenant.currency };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Guard the uuid cast: a stale link like /purchases/new would otherwise reach
  // Postgres as a malformed uuid and surface a 500 instead of a clean 404.
  if (!UUID_PATTERN.test(id)) notFound();
  const { purchase, currency } = await PurchaseDetail({ id });

  return (
    <>
      <Link href="/dashboard/purchases?view=list" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--muted)] transition hover:text-green-800">
        <ArrowLeft size={16} /> All purchases
      </Link>

      <PageHeader
        eyebrow={purchase.invoiceNumber ? `Invoice #${purchase.invoiceNumber}` : "Purchase invoice"}
        title={formatDate(purchase.receivedAt)}
        description={
          purchase.supplierName
            ? `From ${purchase.supplierName}, delivered to ${purchase.locationName}.`
            : `Delivered to ${purchase.locationName}.`
        }
      />

      <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
        <div className="overflow-hidden rounded-2xl border bg-white panel-shadow">
          <Table className="min-w-[720px]">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>#</TH>
                <TH>Ingredient</TH>
                <TH className="text-right">Invoiced qty</TH>
                <TH className="text-right">Price</TH>
                <TH className="text-right">Line total</TH>
                <TH className="text-right">Base qty</TH>
              </TR>
            </THead>
            <TBody>
              {purchase.items.map((item, index) => (
                <TR key={item.id}>
                  <TD className="text-sm text-[var(--muted)]">{index + 1}</TD>
                  <TD>
                    <b>{item.ingredientName}</b>
                    <span className="block text-xs text-[var(--muted)]">base unit {item.baseUnitCode}</span>
                  </TD>
                  <TDNum>{formatQuantity(item.quantity, item.unitCode ?? item.baseUnitCode)}</TDNum>
                  <TDNum>
                    {formatMoney(item.unitCostMillis, currency)}
                    <span className="block text-xs text-[var(--muted)]">/{item.unitCode ?? item.baseUnitCode}</span>
                  </TDNum>
                  <TDNum className="font-semibold">{formatMoney(item.lineTotalMillis, currency)}</TDNum>
                  <TDNum className="text-[var(--muted)]">
                    {item.baseQuantity !== null ? formatQuantity(item.baseQuantity, item.baseUnitCode) : "—"}
                  </TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="flex items-center justify-end gap-4 border-t px-5 py-4">
            <span className="text-sm text-[var(--muted)]">Invoice total:</span>
            <b className="text-lg tabular-nums">{formatMoney(purchase.totalMillis, currency)}</b>
          </div>
        </div>

        <Card>
          <CardContent className="space-y-4 pt-5">
            <div>
              <p className="text-xs font-black uppercase tracking-[.2em] text-[var(--muted)]">Supplier</p>
              <p className="mt-1 font-bold">{purchase.supplierName ?? "No supplier linked"}</p>
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-[.2em] text-[var(--muted)]">Location</p>
              <p className="mt-1 font-bold">{purchase.locationName}</p>
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-[.2em] text-[var(--muted)]">Status</p>
              <div className="mt-1">
                <Badge tone={purchase.status === "received" ? "success" : purchase.status === "draft" ? "neutral" : "danger"}>{purchase.status}</Badge>
              </div>
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-[.2em] text-[var(--muted)]">Recorded</p>
              <p className="mt-1 text-sm">{formatDateTime(purchase.receivedAt)}</p>
            </div>
            {purchase.notes && (
              <div>
                <p className="text-xs font-black uppercase tracking-[.2em] text-[var(--muted)]">Notes</p>
                <p className="mt-1 text-sm">{purchase.notes}</p>
              </div>
            )}
            <div>
              <p className="text-xs font-black uppercase tracking-[.2em] text-[var(--muted)]">Lines</p>
              <p className="mt-1 text-sm font-bold">{purchase.items.length} ingredient{purchase.items.length > 1 ? "s" : ""}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
