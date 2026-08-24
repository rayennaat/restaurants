import Link from "next/link";
import { Upload } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { SectionNav } from "@/components/dashboard/section-nav";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import { resolveMemberLocation } from "@/server/queries/locations";
import { listSalesImports } from "@/server/queries/sales-imports";
import { hasPermission, requireTenant } from "@/server/tenant";

export const metadata = { title: "Import history" };

/**
 * Every import run this workspace has made.
 *
 * Reading is open to any member, matching the rest of the sales screens — an
 * accountant who cannot import still needs to see where the numbers came from.
 * The query is scoped by organization, so this can never show another tenant's
 * runs.
 */
export default async function SalesImportHistoryPage() {
  const tenant = await requireTenant();
  const location = await resolveMemberLocation(tenant, undefined);
  const imports = await listSalesImports(tenant.organizationId, { locationId: location.id });
  const canImport = hasPermission(tenant.role, "manage_sales");

  return (
    <>
      <PageHeader
        eyebrow="Sales"
        title="Import history"
        description="Every sales file brought into this workspace, with what landed and what was skipped."
        action={
          canImport ? (
            <Link
              href="/dashboard/sales/import"
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-[var(--primary)] px-4 font-semibold text-white transition hover:bg-green-800"
            >
              <Upload size={16} /> Import sales
            </Link>
          ) : undefined
        }
      />

      <SectionNav />

      {imports.length > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Runs</p>
            <p className="mt-1 text-2xl font-black tabular-nums">{imports.length}</p>
          </div>
          <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Imported rows</p>
            <p className="mt-1 text-2xl font-black tabular-nums text-green-900">{imports.reduce((total, entry) => total + entry.importedRows, 0).toLocaleString()}</p>
          </div>
          <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Failed rows</p>
            <p className="mt-1 text-2xl font-black tabular-nums text-red-700">{imports.reduce((total, entry) => total + entry.failedRows, 0).toLocaleString()}</p>
          </div>
        </div>
      )}

      {imports.length === 0 ? (
        <Card>
          <EmptyState
            icon={Upload}
            title="No imports yet"
            description="When you bring in a sales file from your till, each run is listed here with its results."
            action={canImport ? { label: "Import sales", href: "/dashboard/sales/import" } : undefined}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table className="min-w-[900px]">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>File</TH>
                <TH>Location</TH>
                <TH>When</TH>
                <TH className="text-right">Rows</TH>
                <TH className="text-right">Imported</TH>
                <TH className="text-right">Skipped</TH>
                <TH className="text-right">Failed</TH>
                <TH className="text-right">Value</TH>
                <TH>Status</TH>
              </TR>
            </THead>
            <TBody>
              {imports.map(entry => (
                <TR key={entry.id} className={entry.failedRows > 0 || entry.status !== "completed" ? "bg-red-50/40" : entry.skippedRows > 0 ? "bg-amber-50/40" : undefined}>
                  <TD>
                    <Link href={`/dashboard/sales/imports/${entry.id}`} className="font-bold text-green-900 hover:underline">
                      {entry.filename ?? `Import ${entry.id.slice(0, 8)}`}
                    </Link>
                    <span className="mt-0.5 block text-xs text-[var(--muted)]">
                      {entry.saleCount.toLocaleString()} sale{entry.saleCount === 1 ? "" : "s"}
                    </span>
                  </TD>
                  <TD className="text-sm text-[var(--muted)]">{entry.locationName}</TD>
                  <TD className="text-sm text-[var(--muted)]">{entry.createdAt.toLocaleString()}</TD>
                  <TDNum>{entry.totalRows.toLocaleString()}</TDNum>
                  <TDNum className="font-semibold text-green-800">{entry.importedRows.toLocaleString()}</TDNum>
                  <TDNum className={entry.skippedRows > 0 ? "text-amber-700" : "text-[var(--muted)]"}>
                    {entry.skippedRows.toLocaleString()}
                  </TDNum>
                  <TDNum className={entry.failedRows > 0 ? "text-red-700" : "text-[var(--muted)]"}>
                    {entry.failedRows.toLocaleString()}
                  </TDNum>
                  <TDNum className="font-semibold">{formatMoney(entry.totalMillis, tenant.currency)}</TDNum>
                  <TD>
                    <Badge tone={entry.status === "completed" ? "success" : "danger"}>
                      {entry.status === "completed" ? "Completed" : "Failed"}
                    </Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      )}
    </>
  );
}
