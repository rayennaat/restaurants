import Link from "next/link";
import { ArrowRight, Clock, PackageCheck, Plus, Truck } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { SectionNav } from "@/components/dashboard/section-nav";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import { TRANSFER_STATUS_LABELS, TRANSFER_STATUS_TONES } from "@/lib/transfers";
import { resolveMemberLocation } from "@/server/queries/locations";
import { listTransfers, type TransferRow } from "@/server/queries/transfers";
import { canAccessAllLocations, hasPermission, requireTenant } from "@/server/tenant";

export const metadata = { title: "Transfers" };

/**
 * Stock transfers between locations.
 *
 * Split into outgoing and incoming because they are different jobs: outgoing is
 * "what have I sent", incoming is "what must I receive". A site-bound member
 * sees only transfers touching their own location — the query is narrowed by
 * `resolveMemberLocation`, so this is not merely a display filter.
 *
 * Reading is open to any member, like every other screen. Creating and receiving
 * require `record_operations`, enforced in the actions rather than by hiding a
 * button.
 */
export default async function TransfersPage() {
  const tenant = await requireTenant();
  const location = await resolveMemberLocation(tenant, undefined);

  // Owners, managers and accountants span the organization; site-bound members
  // see only their own location's transfers, in either direction.
  const visibleLocationIds = canAccessAllLocations(tenant.role) ? null : location.options.map(option => option.id);
  const transfers = await listTransfers(tenant.organizationId, { locationIds: visibleLocationIds });

  const canMove = hasPermission(tenant.role, "record_operations");
  const mine = new Set(location.options.map(option => option.id));

  // For an org-wide viewer every transfer is "outgoing" from somewhere, so the
  // split is by the member's own locations where they have one.
  const outgoing = canAccessAllLocations(tenant.role)
    ? transfers
    : transfers.filter(row => mine.has(row.sourceLocationId));
  const incoming = canAccessAllLocations(tenant.role)
    ? transfers.filter(row => row.status === "sent")
    : transfers.filter(row => mine.has(row.destinationLocationId));

  const awaiting = transfers.filter(row => row.status === "sent").length;
  const drafts = transfers.filter(row => row.status === "draft").length;
  const completed = transfers.filter(row => row.status === "received").length;

  return (
    <>
      <PageHeader
        eyebrow="Inventory"
        title="Transfers"
        description="Move stock between your locations. Stock leaves the source when a transfer is sent and arrives at the destination when someone there confirms it."
        action={
          canMove ? (
            <Link
              href="/dashboard/transfers/new"
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--primary)] px-4 font-semibold text-white transition hover:bg-green-800"
            >
              <Plus size={16} /> New transfer
            </Link>
          ) : undefined
        }
      />

      <SectionNav />

      {transfers.length > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]"><Clock size={13} /> In transit</p>
            <p className="mt-1 text-2xl font-black tabular-nums text-amber-700">{awaiting}</p>
          </div>
          <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Drafts</p>
            <p className="mt-1 text-2xl font-black tabular-nums">{drafts}</p>
          </div>
          <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]"><PackageCheck size={13} /> Received</p>
            <p className="mt-1 text-2xl font-black tabular-nums text-green-900">{completed}</p>
          </div>
        </div>
      )}

      {transfers.length === 0 ? (
        <Card>
          <EmptyState
            icon={Truck}
            title="No transfers yet"
            description="When you move stock from one location to another, each transfer is listed here with what left, what arrived, and what is still on the way."
            action={canMove ? { label: "New transfer", href: "/dashboard/transfers/new" } : undefined}
          />
        </Card>
      ) : (
        <div className="space-y-5">
          {awaiting > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 text-sm text-amber-900">
              <b>
                {awaiting} transfer{awaiting === 1 ? "" : "s"} in transit.
              </b>{" "}
              That stock has left its source and is not counted at either location until it is received.
            </p>
          )}

          <TransferTable
            title={canAccessAllLocations(tenant.role) ? "All transfers" : "Outgoing"}
            description={
              canAccessAllLocations(tenant.role)
                ? "Every transfer in the organization, newest first."
                : "Stock you have sent to other locations."
            }
            rows={outgoing}
            currency={tenant.currency}
            emptyMessage="Nothing sent yet."
          />

          <TransferTable
            title={canAccessAllLocations(tenant.role) ? "Awaiting receipt" : "Incoming"}
            description={
              canAccessAllLocations(tenant.role)
                ? "Sent but not yet confirmed at the destination."
                : "Stock on its way to you. Confirm receipt to add it to your inventory."
            }
            rows={incoming}
            currency={tenant.currency}
            emptyMessage="Nothing incoming."
          />
        </div>
      )}
    </>
  );
}

function TransferTable({
  title,
  description,
  rows,
  currency,
  emptyMessage,
}: {
  title: string;
  description: string;
  rows: TransferRow[];
  currency: string;
  emptyMessage: string;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3 border-b">
        <div>
          <h2 className="text-lg font-black">{title}</h2>
        <p className="text-sm text-[var(--muted)]">{description}</p>
        </div>
        <span className="text-sm font-semibold tabular-nums text-[var(--muted)]">{rows.length} total</span>
      </CardHeader>

      {rows.length === 0 ? (
        <CardContent className="pt-0 text-sm text-[var(--muted)]">{emptyMessage}</CardContent>
      ) : (
        <Table className="min-w-[820px]">
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Transfer</TH>
              <TH>Route</TH>
              <TH>Date</TH>
              <TH className="text-right">Items</TH>
              <TH className="text-right">Value</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map(row => (
              <TR key={row.id} className={row.status === "sent" ? "bg-amber-50/50" : row.status === "cancelled" ? "bg-red-50/40" : undefined}>
                <TD>
                  <Link href={`/dashboard/transfers/${row.id}`} className="font-bold text-green-900 hover:underline">
                    {row.reference ?? `Transfer ${row.id.slice(0, 8)}`}
                  </Link>
                  {row.createdByName && <span className="mt-0.5 block text-xs text-[var(--muted)]">by {row.createdByName}</span>}
                </TD>
                <TD className="text-sm">
                  <span className="inline-flex items-center gap-1.5 text-[var(--muted)]">
                    {row.sourceLocationName}
                    <ArrowRight size={13} />
                    {row.destinationLocationName}
                  </span>
                </TD>
                <TD className="text-sm text-[var(--muted)]">
                  {(row.receivedAt ?? row.sentAt ?? row.createdAt).toLocaleDateString()}
                </TD>
                <TDNum>{row.itemCount}</TDNum>
                <TDNum className="font-semibold">{formatMoney(row.totalValueMillis, currency)}</TDNum>
                <TD>
                  <Badge tone={TRANSFER_STATUS_TONES[row.status]}>{TRANSFER_STATUS_LABELS[row.status]}</Badge>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}
