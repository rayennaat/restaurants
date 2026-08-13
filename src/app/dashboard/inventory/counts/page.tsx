import Link from "next/link";
import { ClipboardList } from "lucide-react";
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

  return (
    <>
      <PageHeader
        eyebrow="Inventory"
        title="Stock counts"
        description="Compare what the system expects you to hold against what is physically on the shelf. Approving a count corrects your stock without erasing any history."
        action={canCount ? <NewCountButton locations={location.options} categories={categories} /> : undefined}
      />

      <SectionNav />

      {counts.length === 0 ? (
        <Card>
          <EmptyState
            icon={ClipboardList}
            title="No stock counts yet"
            description="Create your first physical inventory count to compare your actual stock with the system."
            action={undefined}
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
                <TR key={count.id}>
                  <TD>
                    <Link href={`/dashboard/inventory/counts/${count.id}`} className="font-bold text-green-900 hover:underline">
                      {count.reference ?? `Count ${count.id.slice(0, 8)}`}
                    </Link>
                  </TD>
                  <TD className="text-sm text-[var(--muted)]">{count.locationName}</TD>
                  <TD className="text-sm text-[var(--muted)]">{count.createdByName ?? "—"}</TD>
                  <TD className="text-sm text-[var(--muted)]">{count.createdAt.toLocaleDateString()}</TD>
                  <TDNum>
                    {count.countedCount}/{count.itemCount}
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
