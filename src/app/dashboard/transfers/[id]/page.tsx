import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, PackageCheck } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { CancelTransferButton, ReceiveTransferButton, SendTransferButton } from "@/components/transfers/transfer-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import { TRANSFER_STATUS_LABELS, TRANSFER_STATUS_TONES } from "@/lib/transfers";
import { listLocationOptions } from "@/server/queries/locations";
import { getTransfer } from "@/server/queries/transfers";
import { canAccessAllLocations, hasPermission, requireTenant } from "@/server/tenant";

export const metadata = { title: "Transfer" };

/**
 * One transfer, and whatever action it is currently waiting for.
 *
 * Which buttons appear depends on both the status and the viewer's locations:
 * sending is offered to someone who may act at the source, receiving to someone
 * at the destination. The actions re-check all of it — this only decides what is
 * worth showing.
 *
 * `getTransfer` is scoped by organization, so an id from another workspace is a
 * 404 rather than a permission error. That is deliberate: a "not allowed"
 * message would confirm the transfer exists.
 */
export default async function TransferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await requireTenant();

  const transfer = await getTransfer(tenant.organizationId, id);
  if (!transfer) notFound();
  if (
    !canAccessAllLocations(tenant.role) &&
    tenant.locationId !== transfer.sourceLocationId &&
    tenant.locationId !== transfer.destinationLocationId
  ) {
    notFound();
  }

  const allLocations = await listLocationOptions(tenant.organizationId);
  const myLocationIds = canAccessAllLocations(tenant.role)
    ? allLocations.map(option => option.id)
    : allLocations.filter(option => option.id === tenant.locationId).map(option => option.id);

  const canMove = hasPermission(tenant.role, "record_operations");
  const canSend = canMove && transfer.status === "draft" && myLocationIds.includes(transfer.sourceLocationId);
  const canReceive = canMove && transfer.status === "sent" && myLocationIds.includes(transfer.destinationLocationId);
  const canCancel =
    hasPermission(tenant.role, "manage_stock_counts") &&
    (transfer.status === "draft" || transfer.status === "sent") &&
    myLocationIds.includes(transfer.sourceLocationId);

  const shortLines = transfer.items.filter(item => item.baseQuantity > item.availableAtSource + 1e-6);

  return (
    <>
      <Link
        href="/dashboard/transfers"
        className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-[var(--muted)] hover:text-neutral-900"
      >
        <ArrowLeft size={15} /> Transfers
      </Link>

      <PageHeader
        eyebrow="Transfer"
        title={transfer.reference ?? `Transfer ${transfer.id.slice(0, 8)}`}
        description={`${transfer.sourceLocationName} → ${transfer.destinationLocationName}`}
        action={<Badge tone={TRANSFER_STATUS_TONES[transfer.status]}>{TRANSFER_STATUS_LABELS[transfer.status]}</Badge>}
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Items</p>
          <p className="mt-1 text-2xl font-black tabular-nums">{transfer.items.length}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Value</p>
          <p className="mt-1 text-2xl font-black tabular-nums text-green-900">{formatMoney(transfer.totalValueMillis, tenant.currency)}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]"><PackageCheck size={13} /> Status</p>
          <p className="mt-1 text-sm font-bold">{TRANSFER_STATUS_LABELS[transfer.status]}</p>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          {transfer.status === "sent" && (
            <p className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900">
              <b>In transit.</b> This stock has been deducted from {transfer.sourceLocationName} and is not yet counted at{" "}
              {transfer.destinationLocationName}. It joins that location&apos;s inventory when someone there confirms receipt.
            </p>
          )}

          {transfer.status === "cancelled" && (
            <p className="rounded-lg border border-red-200 bg-red-50/60 px-4 py-3 text-sm text-red-900">
              <b>Cancelled.</b> {transfer.cancelReason ?? "No reason recorded."}
            </p>
          )}

          {transfer.status === "draft" && shortLines.length > 0 && (
            <p className="rounded-lg border border-red-200 bg-red-50/60 px-4 py-3 text-sm text-red-900">
              <b>Not enough stock.</b> {shortLines.length} line{shortLines.length === 1 ? "" : "s"} ask for more than{" "}
              {transfer.sourceLocationName} currently holds. Sending will be refused until the quantities fit.
            </p>
          )}

          <Card className="overflow-hidden">
            <CardHeader className="border-b">
              <h2 className="text-lg font-black">What is moving</h2>
              <p className="text-sm text-[var(--muted)]">
                Quantities are recorded in each ingredient&apos;s base unit, converted from whatever was entered.
              </p>
            </CardHeader>
            <Table className="min-w-[680px]">
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Ingredient</TH>
                  <TH className="text-right">Entered</TH>
                  <TH className="text-right">Base quantity</TH>
                  <TH className="text-right">
                    {transfer.status === "draft" ? "At source now" : "At source"}
                  </TH>
                  <TH className="text-right">Value</TH>
                </TR>
              </THead>
              <TBody>
                {transfer.items.map(item => {
                  const short = transfer.status === "draft" && item.baseQuantity > item.availableAtSource + 1e-6;
                  return (
                    <TR key={item.id}>
                      <TD className="font-semibold">{item.ingredientName}</TD>
                      <TDNum>
                        {item.quantity.toLocaleString(undefined, { maximumFractionDigits: 3 })} {item.unitCode ?? item.baseUnitCode}
                      </TDNum>
                      <TDNum>
                        {item.baseQuantity.toLocaleString(undefined, { maximumFractionDigits: 3 })} {item.baseUnitCode}
                      </TDNum>
                      <TDNum className={short ? "font-bold text-red-600" : "text-[var(--muted)]"}>
                        {item.availableAtSource.toLocaleString(undefined, { maximumFractionDigits: 3 })} {item.baseUnitCode}
                      </TDNum>
                      <TDNum className="font-semibold">{formatMoney(item.valueMillis, tenant.currency)}</TDNum>
                    </TR>
                  );
                })}
                <TR className="bg-neutral-50 hover:bg-neutral-50">
                  <TD className="font-black" colSpan={4}>
                    Total
                  </TD>
                  <TDNum className="font-black">{formatMoney(transfer.totalValueMillis, tenant.currency)}</TDNum>
                </TR>
              </TBody>
            </Table>
          </Card>

          {transfer.note && (
            <Card>
              <CardHeader>
                <h2 className="text-lg font-black">Note</h2>
              </CardHeader>
              <CardContent className="pt-0 text-sm">{transfer.note}</CardContent>
            </Card>
          )}
        </div>

        {/* ------------------------------------------------------- side panel */}
        <div className="space-y-5">
          <Card>
            <CardHeader className="border-b bg-neutral-50/60">
              <h2 className="text-base font-black">Route</h2>
            </CardHeader>
            <CardContent className="pt-0">
              <p className="flex items-center gap-2 text-sm font-semibold">
                {transfer.sourceLocationName}
                <ArrowRight size={14} className="text-[var(--muted)]" />
                {transfer.destinationLocationName}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <h2 className="text-base font-black">History</h2>
            </CardHeader>
            <CardContent className="space-y-3 pt-0 text-sm">
              <Event label="Created" name={transfer.createdByName} at={transfer.createdAt} />
              {transfer.sentAt && <Event label="Sent" name={transfer.sentByName} at={transfer.sentAt} />}
              {transfer.receivedAt && <Event label="Received" name={transfer.receivedByName} at={transfer.receivedAt} />}
              {transfer.cancelledAt && <Event label="Cancelled" name={null} at={transfer.cancelledAt} />}
            </CardContent>
          </Card>

          {(canSend || canReceive || canCancel) && (
            <Card>
              <CardHeader>
                <h2 className="text-base font-black">
                  {canReceive ? "Confirm arrival" : canSend ? "Ready to send" : "Actions"}
                </h2>
                {canReceive && (
                  <p className="text-sm text-[var(--muted)]">
                    Check the goods against the list, then confirm — this adds the stock to {transfer.destinationLocationName}.
                  </p>
                )}
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                {canSend && <SendTransferButton transferId={transfer.id} />}
                {canReceive && (
                  <ReceiveTransferButton transferId={transfer.id} destinationName={transfer.destinationLocationName} />
                )}
                {canCancel && <CancelTransferButton transferId={transfer.id} wasSent={transfer.status === "sent"} />}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Event({ label, name, at }: { label: string; name: string | null; at: Date }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[var(--muted)]">{label}</span>
      <span className="text-right">
        <b className="block">{at.toLocaleDateString()}</b>
        {name && <span className="text-xs text-[var(--muted)]">{name}</span>}
      </span>
    </div>
  );
}
