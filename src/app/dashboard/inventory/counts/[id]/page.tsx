import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { CountSheet } from "@/components/inventory/count-sheet";
import { Badge } from "@/components/ui/badge";
import { STOCK_COUNT_STATUS_LABELS, type StockCountStatus } from "@/lib/stock-count";
import { getStockCount } from "@/server/queries/stock-counts";
import { canAccessAllLocations, hasPermission, requireTenant } from "@/server/tenant";

export const metadata = { title: "Stock count" };

const STATUS_TONE: Record<StockCountStatus, "neutral" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  counting: "neutral",
  submitted: "warning",
  approved: "success",
  rejected: "danger",
};

/**
 * One count sheet.
 *
 * `getStockCount` is scoped by organization, so a count id belonging to another
 * tenant resolves to nothing and 404s rather than leaking its existence.
 */
export default async function StockCountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await requireTenant();

  const count = await getStockCount(tenant.organizationId, id);
  if (!count) notFound();

  // A site-bound member may only open counts for their own location.
  if (!canAccessAllLocations(tenant.role) && tenant.locationId !== count.locationId) notFound();

  return (
    <>
      <Link
        href="/dashboard/inventory/counts"
        className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-[var(--muted)] hover:text-neutral-900"
      >
        <ArrowLeft size={15} /> All stock counts
      </Link>

      <PageHeader
        eyebrow={count.locationName}
        title={count.reference ?? `Count ${count.id.slice(0, 8)}`}
        description={
          count.note ??
          "Physical quantities are compared against the stock ledger. Nothing changes until a manager approves the count."
        }
        action={<Badge tone={STATUS_TONE[count.status]}>{STOCK_COUNT_STATUS_LABELS[count.status]}</Badge>}
      />

      <CountSheet
        count={count}
        currency={tenant.currency}
        canCount={hasPermission(tenant.role, "manage_stock_counts")}
        canApprove={hasPermission(tenant.role, "approve_stock_counts")}
      />
    </>
  );
}
