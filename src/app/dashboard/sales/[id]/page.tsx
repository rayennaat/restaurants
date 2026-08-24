import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Info } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { VoidSaleButton } from "@/components/sales/void-sale-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import { getSale } from "@/server/queries/sales";
import { canAccessAllLocations, hasPermission, requireTenant } from "@/server/tenant";

export const metadata = { title: "Sale" };

const SOURCE_LABELS: Record<string, string> = { manual: "Manual entry", csv_import: "CSV import", pos_import: "POS import" };

/**
 * One sale.
 *
 * Scoped by organization inside the query, so an id from another tenant 404s
 * rather than revealing that it exists. Site-bound roles cannot open a sale from
 * a location they are not assigned to.
 */
export default async function SaleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await requireTenant();

  const sale = await getSale(tenant.organizationId, id);
  if (!sale) notFound();
  if (!canAccessAllLocations(tenant.role) && tenant.locationId !== sale.locationId) notFound();

  const isVoided = sale.status === "voided";
  // A dish whose menu price has moved since. Shown as context, never used to
  // value the sale — the line keeps the price it sold at.
  const repriced = sale.lines.filter(line => line.currentPriceMillis !== null && line.currentPriceMillis !== line.unitPriceMillis);

  return (
    <>
      <Link href="/dashboard/sales" className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-[var(--muted)] hover:text-neutral-900">
        <ArrowLeft size={15} /> All sales
      </Link>

      <PageHeader
        eyebrow={sale.locationName}
        title={sale.reference ?? `Sale ${sale.id.slice(0, 8)}`}
        description={`${SOURCE_LABELS[sale.source] ?? sale.source} · ${sale.soldAt.toLocaleString()}`}
        action={
          hasPermission(tenant.role, "manage_sales") && !isVoided ? <VoidSaleButton saleId={sale.id} /> : isVoided ? <Badge tone="danger">Voided</Badge> : undefined
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Total</p>
          <p className={isVoided ? "mt-1 text-2xl font-black tabular-nums text-[var(--muted)] line-through" : "mt-1 text-2xl font-black tabular-nums text-green-900"}>{formatMoney(sale.totalMillis, tenant.currency)}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Lines</p>
          <p className="mt-1 text-2xl font-black tabular-nums">{sale.lines.length}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Source</p>
          <p className="mt-1 text-sm font-bold">{SOURCE_LABELS[sale.source] ?? sale.source}</p>
        </div>
      </div>

      {isVoided && (
        <Card className="mb-6 border-red-200 bg-red-50/50">
          <CardContent className="pt-5">
            <p className="text-sm font-black text-red-800">This sale was voided</p>
            {sale.voidReason && <p className="mt-1 text-sm text-red-900/80">{sale.voidReason}</p>}
            <p className="mt-2 text-xs text-[var(--muted)]">
              It is excluded from all revenue figures but kept on record{sale.voidedAt ? ` · voided ${sale.voidedAt.toLocaleString()}` : ""}.
            </p>
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <h2 className="text-lg font-black">Items sold</h2>
          <p className="text-sm text-[var(--muted)]">Priced as sold. A later menu change does not alter these figures.</p>
        </CardHeader>
        <Table className="min-w-[680px]">
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Item</TH>
              <TH className="text-right">Quantity</TH>
              <TH className="text-right">Price as sold</TH>
              <TH className="text-right">Line total</TH>
            </TR>
          </THead>
          <TBody>
            {sale.lines.map(line => (
              <TR key={line.id}>
                <TD>
                  <b className="text-sm">{line.menuItemName}</b>
                  {line.currentPriceMillis !== null && line.currentPriceMillis !== line.unitPriceMillis && (
                    <span className="block text-xs text-[var(--muted)]">
                      Now {formatMoney(line.currentPriceMillis, tenant.currency)} on the menu
                    </span>
                  )}
                </TD>
                <TDNum>{line.quantity.toLocaleString()}</TDNum>
                <TDNum>{formatMoney(line.unitPriceMillis, tenant.currency)}</TDNum>
                <TDNum className="font-semibold">{formatMoney(line.lineTotalMillis, tenant.currency)}</TDNum>
              </TR>
            ))}
            <TR className="hover:bg-transparent">
              <TD colSpan={3} className="text-right text-sm font-bold">
                Total
              </TD>
              <TDNum className="text-lg font-black">{formatMoney(sale.totalMillis, tenant.currency)}</TDNum>
            </TR>
          </TBody>
        </Table>
      </Card>

      {repriced.length > 0 && (
        <Card className="mt-6">
          <CardContent className="flex items-start gap-3 pt-5 text-sm text-[var(--muted)]">
            <Info size={18} className="mt-0.5 shrink-0" />
            <span>
              {repriced.length} item{repriced.length === 1 ? " has" : "s have"} been re-priced on the menu since this sale.
              The figures above are unchanged, which is the point: revenue is recorded at the price that was actually
              charged.
            </span>
          </CardContent>
        </Card>
      )}

      {sale.note && (
        <Card className="mt-6">
          <CardHeader>
            <h2 className="font-black">Note</h2>
          </CardHeader>
          <CardContent className="text-sm text-[var(--muted)]">{sale.note}</CardContent>
        </Card>
      )}
    </>
  );
}
