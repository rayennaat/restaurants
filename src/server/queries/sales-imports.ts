import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { locations, saleLines, sales, salesImports } from "@/db/schema";

/**
 * Import history queries.
 *
 * Every read is scoped by organization in the WHERE clause — the same rule as
 * the rest of the sales screens — so an import id from another tenant resolves
 * to nothing rather than leaking that it exists.
 */

export type SalesImportListRow = {
  id: string;
  status: "completed" | "failed";
  filename: string | null;
  locationName: string;
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  failedRows: number;
  duplicateRows: number;
  saleCount: number;
  totalMillis: number;
  createdAt: Date;
};

/** Import runs, newest first. A location id narrows site-bound members. */
export async function listSalesImports(
  organizationId: string,
  options: { locationId?: string | null; limit?: number } = {},
): Promise<SalesImportListRow[]> {
  const db = getDb();
  const conditions = [eq(salesImports.organizationId, organizationId)];
  if (options.locationId) conditions.push(eq(salesImports.locationId, options.locationId));

  const rows = await db
    .select({
      id: salesImports.id,
      status: salesImports.status,
      filename: salesImports.filename,
      locationName: locations.name,
      totalRows: salesImports.totalRows,
      importedRows: salesImports.importedRows,
      skippedRows: salesImports.skippedRows,
      failedRows: salesImports.failedRows,
      duplicateRows: salesImports.duplicateRows,
      saleCount: salesImports.saleCount,
      totalMillis: salesImports.totalMillis,
      createdAt: salesImports.createdAt,
    })
    .from(salesImports)
    .innerJoin(locations, eq(locations.id, salesImports.locationId))
    .where(and(...conditions))
    .orderBy(desc(salesImports.createdAt))
    .limit(options.limit ?? 50);

  return rows;
}

export type SalesImportDetail = {
  id: string;
  status: "completed" | "failed";
  adapter: string;
  filename: string | null;
  fileSize: number | null;
  locationId: string;
  locationName: string;
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  failedRows: number;
  duplicateRows: number;
  saleCount: number;
  totalMillis: number;
  /** Parsed `mapping` column. Null when the row is unreadable — never thrown. */
  mapping: Record<string, string> | null;
  /** Parsed `issue_summary` column, sorted most frequent first. */
  issueSummary: { code: string; count: number }[];
  errorMessage: string | null;
  createdAt: Date;
};

/** One run with its stored summary, for the detail screen. */
export async function getSalesImport(organizationId: string, importId: string): Promise<SalesImportDetail | null> {
  const db = getDb();

  const [row] = await db
    .select({
      id: salesImports.id,
      status: salesImports.status,
      adapter: salesImports.adapter,
      filename: salesImports.filename,
      fileSize: salesImports.fileSize,
      locationId: salesImports.locationId,
      locationName: locations.name,
      totalRows: salesImports.totalRows,
      importedRows: salesImports.importedRows,
      skippedRows: salesImports.skippedRows,
      failedRows: salesImports.failedRows,
      duplicateRows: salesImports.duplicateRows,
      saleCount: salesImports.saleCount,
      totalMillis: salesImports.totalMillis,
      mapping: salesImports.mapping,
      issueSummary: salesImports.issueSummary,
      errorMessage: salesImports.errorMessage,
      createdAt: salesImports.createdAt,
    })
    .from(salesImports)
    .innerJoin(locations, eq(locations.id, salesImports.locationId))
    .where(and(eq(salesImports.id, importId), eq(salesImports.organizationId, organizationId)))
    .limit(1);

  if (!row) return null;

  let mapping: Record<string, string> | null = null;
  try {
    const parsed = row.mapping ? (JSON.parse(row.mapping) as { mapping?: Record<string, string> }) : null;
    mapping = parsed?.mapping ?? null;
  } catch {
    mapping = null;
  }

  let issueSummary: { code: string; count: number }[] = [];
  try {
    const parsed = row.issueSummary ? (JSON.parse(row.issueSummary) as Record<string, number>) : null;
    issueSummary = parsed
      ? Object.entries(parsed)
          .map(([code, value]) => ({ code, count: Number(value) }))
          .sort((a, b) => b.count - a.count)
      : [];
  } catch {
    issueSummary = [];
  }

  return {
    id: row.id,
    status: row.status,
    adapter: row.adapter,
    filename: row.filename,
    fileSize: row.fileSize,
    locationId: row.locationId,
    locationName: row.locationName,
    totalRows: row.totalRows,
    importedRows: row.importedRows,
    skippedRows: row.skippedRows,
    failedRows: row.failedRows,
    duplicateRows: row.duplicateRows,
    saleCount: row.saleCount,
    totalMillis: row.totalMillis,
    mapping,
    issueSummary,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
  };
}

export type ImportedSaleRow = {
  id: string;
  reference: string | null;
  soldAt: Date;
  totalMillis: number;
  lineCount: number;
};

/** The sales a run created, for the detail screen's link-through. */
export async function listSalesForImport(organizationId: string, importId: string, limit = 200): Promise<ImportedSaleRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: sales.id,
      reference: sales.reference,
      soldAt: sales.soldAt,
      totalMillis: sales.totalMillis,
      // Same subquery-count shape as `listSales`: joining `sale_lines` here
      // would repeat each sale once per line and multiply its total.
      lineCount: db.$count(saleLines, eq(saleLines.saleId, sales.id)),
    })
    .from(sales)
    .where(and(eq(sales.organizationId, organizationId), eq(sales.importId, importId)))
    .orderBy(asc(sales.soldAt))
    .limit(limit);

  return rows.map(row => ({ ...row, lineCount: Number(row.lineCount ?? 0) }));
}
