import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Receipt } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney } from "@/lib/money";
import { FIELD_LABELS, ISSUE_LABELS, ISSUE_SEVERITY, type ImportField, type ImportIssueCode } from "@/lib/sales-import";
import { getSalesImport, listSalesForImport } from "@/server/queries/sales-imports";
import { canAccessAllLocations, requireTenant } from "@/server/tenant";

export const metadata = { title: "Import" };

/**
 * One import run.
 *
 * Scoped by organization inside the query, so an id from another tenant 404s
 * rather than confirming it exists. A site-bound member cannot open a run that
 * targeted another location — the same rule the sale detail screen applies.
 */
export default async function SalesImportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await requireTenant();

  const entry = await getSalesImport(tenant.organizationId, id);
  if (!entry) notFound();
  if (!canAccessAllLocations(tenant.role) && tenant.locationId !== entry.locationId) notFound();

  const createdSales = await listSalesForImport(tenant.organizationId, entry.id);

  return (
    <>
      <Link
        href="/dashboard/sales/imports"
        className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-[var(--muted)] hover:text-neutral-900"
      >
        <ArrowLeft size={15} /> Import history
      </Link>

      <PageHeader
        eyebrow={entry.locationName}
        title={entry.filename ?? `Import ${entry.id.slice(0, 8)}`}
        description={`${entry.adapter === "csv" ? "CSV upload" : entry.adapter} · ${entry.createdAt.toLocaleString()}`}
        action={<Badge tone={entry.status === "completed" ? "success" : "danger"}>{entry.status === "completed" ? "Completed" : "Failed"}</Badge>}
      />

      {entry.errorMessage && (
        <Card className="mb-6 border-red-200 bg-red-50/50">
          <CardContent className="pt-5">
            <p className="text-sm font-black text-red-800">This import failed</p>
            <p className="mt-1 text-sm text-red-900/80">{entry.errorMessage}</p>
            <p className="mt-2 text-xs text-[var(--muted)]">No sales were created — an import either completes fully or leaves nothing behind.</p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Figure label="Rows in file" value={entry.totalRows.toLocaleString()} />
        <Figure label="Imported" value={entry.importedRows.toLocaleString()} tone="success" />
        <Figure label="Skipped" value={entry.skippedRows.toLocaleString()} tone={entry.skippedRows > 0 ? "warning" : "neutral"} />
        <Figure label="Failed" value={entry.failedRows.toLocaleString()} tone={entry.failedRows > 0 ? "danger" : "neutral"} />
        <Figure label="Value" value={formatMoney(entry.totalMillis, tenant.currency)} />
      </div>

      <div className="mt-6 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader className="border-b">
            <h2 className="text-lg font-black">How the columns were matched</h2>
            <p className="text-sm text-[var(--muted)]">The mapping used for this run, kept so it can be explained or repeated.</p>
          </CardHeader>
          <CardContent>
            {entry.mapping && Object.keys(entry.mapping).length > 0 ? (
              <dl className="space-y-2 text-sm">
                {Object.entries(entry.mapping).map(([field, column]) => (
                  <div key={field} className="flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5">
                    <dt className="font-semibold">{FIELD_LABELS[field as ImportField] ?? field}</dt>
                    <dd className="text-[var(--muted)]">{column}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-[var(--muted)]">No mapping was recorded for this run.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <h2 className="text-lg font-black">What needed attention</h2>
            <p className="text-sm text-[var(--muted)]">
              {entry.duplicateRows > 0
                ? `${entry.duplicateRows.toLocaleString()} row(s) were already imported and were not counted twice.`
                : "Problems found while reading this file."}
            </p>
          </CardHeader>
          <CardContent>
            {entry.issueSummary.length ? (
              <div className="space-y-2">
                {entry.issueSummary.map(issue => {
                  const code = issue.code as ImportIssueCode;
                  const severity = ISSUE_SEVERITY[code];
                  return (
                    <div key={issue.code} className="flex items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm">
                      <span className="flex items-center gap-2">
                        {severity && (
                          <Badge tone={severity === "error" ? "danger" : "warning"}>
                            {severity === "error" ? "Skipped" : "Imported"}
                          </Badge>
                        )}
                        {ISSUE_LABELS[code] ?? issue.code}
                      </span>
                      <b className="tabular-nums">{issue.count.toLocaleString()}</b>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-[var(--muted)]">Every row imported cleanly.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <section className="mt-6">
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <h2 className="text-lg font-black">Sales created</h2>
            <p className="text-sm text-[var(--muted)]">
              {entry.saleCount.toLocaleString()} sale{entry.saleCount === 1 ? "" : "s"} from this file, priced as the file
              recorded them.
            </p>
          </CardHeader>
          {createdSales.length === 0 ? (
            <CardContent>
              <EmptyState
                icon={Receipt}
                title="No sales from this run"
                description="Every row was skipped, or the sales have since been removed."
                className="py-8"
              />
            </CardContent>
          ) : (
            <Table className="min-w-[620px]">
              <THead>
                <TR className="hover:bg-transparent">
                  <TH>Sale</TH>
                  <TH>When</TH>
                  <TH className="text-right">Lines</TH>
                  <TH className="text-right">Total</TH>
                </TR>
              </THead>
              <TBody>
                {createdSales.map(sale => (
                  <TR key={sale.id}>
                    <TD>
                      <Link href={`/dashboard/sales/${sale.id}`} className="font-bold text-green-900 hover:underline">
                        {sale.reference ?? `Sale ${sale.id.slice(0, 8)}`}
                      </Link>
                    </TD>
                    <TD className="text-sm text-[var(--muted)]">{sale.soldAt.toLocaleString()}</TD>
                    <TDNum>{sale.lineCount}</TDNum>
                    <TDNum className="font-semibold">{formatMoney(sale.totalMillis, tenant.currency)}</TDNum>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </section>
    </>
  );
}

function Figure({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "success" | "warning" | "danger" }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--muted)]">{label}</p>
        <p
          className={`mt-1 text-2xl font-black tabular-nums ${
            tone === "success" ? "text-green-800" : tone === "warning" ? "text-amber-700" : tone === "danger" ? "text-red-700" : ""
          }`}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
