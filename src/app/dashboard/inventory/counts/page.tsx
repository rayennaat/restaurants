import Link from "next/link";
import { AlertTriangle, ClipboardList } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { SectionNav } from "@/components/dashboard/section-nav";
import { NewCountButton } from "@/components/inventory/new-count-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import { STOCK_COUNT_STATUS_LABELS, type StockCountStatus } from "@/lib/stock-count";
import { listIngredientCategories } from "@/server/queries/ingredients";
import { resolveMemberLocation } from "@/server/queries/locations";
import { listStockCounts } from "@/server/queries/stock-counts";
import { hasPermission, requireTenant } from "@/server/tenant";

export const metadata = { title: "Stock counts" };

const STATUS_TONE: Record<StockCountStatus, "neutral" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  counting: "neutral",
  submitted: "warning",
  approved: "success",
  rejected: "danger",
};

/**
 * Stock count history.
 *
 * Counts are visible to any member; creating one requires `manage_stock_counts`.
 * The location list is narrowed by `resolveMemberLocation`, so a site-bound
 * member can only ever open a count against their own location.
 */
export default async function StockCountsPage() {
  const tenant = await requireTenant();
  const location = await resolveMemberLocation(tenant, undefined);

  const [counts, categories] = await Promise.all([
    listStockCounts(tenant.organizationId, { locationId: location.id }),
    listIngredientCategories(tenant.organizationId),
  ]);

  const canCount = hasPermission(tenant.role, "manage_stock_counts");
  const awaitingApproval = counts.filter(count => count.status === "submitted");
  const inProgress = counts.filter(count => count.status === "draft" || count.status === "counting");
  const completed = counts.filter(count => count.status === "approved");

  return (
    <>
      <PageHeader
        eyebrow="Inventory"
        title="Stock counts"
        description="Compare what the system expects you to hold against what is physically on the shelf. Approving a count corrects your stock without erasing any history."
        action={canCount ? <NewCountButton locations={location.options} categories={categories} /> : undefined}
      />

      <SectionNav />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Awaiting approval</p>
          <p className="mt-1 text-2xl font-black tabular-nums text-amber-700">{awaitingApproval.length}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">In progress</p>
          <p className="mt-1 text-2xl font-black tabular-nums text-green-900">{inProgress.length}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Approved</p>
          <p className="mt-1 text-2xl font-black tabular-nums">{completed.length}</p>
        </div>
      </div>

      {awaitingApproval.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 text-sm text-amber-950">
          <p className="inline-flex items-center gap-2">
            <AlertTriangle size={16} />
            <b>{awaitingApproval.length} submitted count{awaitingApproval.length === 1 ? "" : "s"} awaiting approval</b>
          </p>
          <Link href={`/dashboard/inventory/counts/${awaitingApproval[0].id}`} className="font-semibold text-green-900 hover:underline">
            Review first
          </Link>
        </div>
      )}

      {counts.length === 0 ? (
        <Card>
          <EmptyState
            icon={ClipboardList}
            title="No stock counts yet"
            description="Create your first physical inventory count to compare your actual stock with the system."
            action={canCount ? <NewCountButton locations={location.options} categories={categories} /> : undefined}
          />
          {!canCount && (
            <CardContent className="pt-0 text-center text-sm text-[var(--muted)]">
              Your role can view counts but not start one.
            </CardContent>
          )}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table className="min-w-[860px]">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Count</TH>
                <TH>Location</TH>
                <TH>Started by</TH>
                <TH>Date</TH>
                <TH className="text-right">Items</TH>
                <TH className="text-right">Net variance</TH>
                <TH className="text-right">Status</TH>
              </TR>
            </THead>
            <TBody>
              {counts.map(count => (
                <TR key={count.id} className={count.status === "submitted" ? "bg-amber-50/60" : count.status === "rejected" ? "bg-red-50/50" : undefined}>
                  <TD>
                    <Link href={`/dashboard/inventory/counts/${count.id}`} className="font-bold text-green-900 hover:underline">
                      {count.reference ?? `Count ${count.id.slice(0, 8)}`}
                    </Link>
                  </TD>
                  <TD className="text-sm text-[var(--muted)]">{count.locationName}</TD>
                  <TD className="text-sm text-[var(--muted)]">{count.createdByName ?? "—"}</TD>
                  <TD className="text-sm text-[var(--muted)]">{count.createdAt.toLocaleDateString()}</TD>
                  <TDNum>
                    <span className="font-semibold">{count.countedCount}/{count.itemCount}</span>
                    <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-neutral-100">
                      <span
                        className="block h-full bg-green-700"
                        style={{ width: count.itemCount > 0 ? Math.min((count.countedCount / count.itemCount) * 100, 100) + "%" : "0%" }}
                      />
                    </span>
                  </TDNum>
                  <TDNum
                    className={count.netValueMillis < 0 ? "font-semibold text-red-700" : count.netValueMillis > 0 ? "font-semibold text-green-800" : ""}
                  >
                    {count.status === "approved" || count.status === "submitted" || count.countedCount > 0
                      ? formatMoney(count.netValueMillis, tenant.currency)
                      : "—"}
                  </TDNum>
                  <TDNum>
                    <Badge tone={STATUS_TONE[count.status]}>{STOCK_COUNT_STATUS_LABELS[count.status]}</Badge>
                  </TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}
