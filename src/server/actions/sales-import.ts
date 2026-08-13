"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { menuItems, saleLines, sales, salesImports } from "@/db/schema";
import { parseCsv, CsvParseError, type CsvDelimiter } from "@/lib/csv";
import { buildImportedSaleLines } from "@/lib/sales";
import {
  buildImportPlan,
  missingRequiredFields,
  rowsFromTable,
  suggestMapping,
  FIELD_LABELS,
  type ColumnMapping,
  type ImportPlan,
  type RowOutcome,
} from "@/lib/sales-import";
import {
  commitSalesImportInput,
  previewSalesImportInput,
  IMPORT_MAX_ROWS,
  type CommitSalesImportInput,
} from "@/lib/validation";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { assertMemberLocation, listLocationOptions } from "@/server/queries/locations";
import { loadConsumptionRequirements, postSaleConsumption } from "@/server/sale-consumption";
import { canAccessAllLocations, getOrganizationUnits, requirePermission, requireTenant, type TenantContext } from "@/server/tenant";
import { ActionError } from "@/lib/action-error";

/**
 * Importing sales from a CSV export.
 *
 * The shape of this module is one decision repeated:
 *
 * **The server rebuilds the plan on every call.** Preview and commit take the
 * same input and run the same {@link buildImportPlan}; the commit never accepts
 * a plan the client computed. A tampered request therefore cannot invent a
 * price, reach a menu item in another workspace, or resurrect a row the
 * validator rejected — because none of those survive re-validation against a
 * catalog loaded for the caller's own organization.
 *
 * **Nothing is created implicitly.** An unrecognized dish name is an error the
 * user resolves by pointing at an existing menu item. An import that could
 * silently create menu items would let a mistyped export quietly grow a second
 * catalog, and every margin figure downstream would be computed against dishes
 * with no recipe behind them.
 *
 * **One transaction.** The import receipt, every sale, and every line are
 * written together, and the audit entry with them. A failure part-way leaves no
 * sales and no receipt claiming success.
 *
 * **Re-running is a no-op.** Each planned sale carries a deterministic
 * `externalId`; the partial unique index on (organization, source, external_id)
 * is the real guarantee, and the rows already present are filtered out before
 * the write so the second run reports duplicates instead of failing.
 *
 * The CSV parse is the only part specific to files. Everything after it operates
 * on rows and a mapping, which is the same surface a future POS adapter will
 * produce — see `SalesImportAdapter` in `lib/sales-import`.
 */

/** Location a member may import into. Mirrors the manual-entry guard. */
async function assertLocationAllowed(
  tenant: Pick<TenantContext, "organizationId" | "role" | "locationId">,
  locationId: string,
) {
  await assertMemberLocation(tenant, locationId, "import sales");
}

/**
 * Parses the upload, loads the tenant's own catalog, and plans the import.
 *
 * Shared verbatim by preview and commit so the two cannot diverge — the reason
 * the preview can be trusted as a description of what the commit will do.
 */
async function planImport(values: CommitSalesImportInput | Omit<CommitSalesImportInput, "expectedImportedRows">, tenant: TenantContext) {
  const table = parseCsv(values.content, {
    delimiter: values.delimiter as CsvDelimiter | undefined,
    maxRows: IMPORT_MAX_ROWS,
  });

  if (!table.headers.length) throw new ActionError("That file has no columns to read.");
  if (!table.rows.length) throw new ActionError("That file has a header but no data rows.");

  // A mapping naming a column the file does not contain would silently read
  // every row as empty, which surfaces as "every row failed" and sends the user
  // hunting through their data instead of their mapping.
  const known = new Set(table.headers);
  const mapping: ColumnMapping = {};
  for (const [field, column] of Object.entries(values.mapping ?? {})) {
    if (!column) continue;
    if (!known.has(column)) {
      throw new ActionError(`The file has no column named "${column}".`);
    }
    mapping[field as keyof ColumnMapping] = column;
  }

  const missing = missingRequiredFields(mapping);
  if (missing.length) {
    throw new ActionError(`Choose a column for: ${missing.map(field => FIELD_LABELS[field]).join(", ")}.`);
  }

  const db = getDb();

  /**
   * The catalog, scoped to the caller's organization.
   *
   * This single WHERE clause is the import's tenant boundary: a dish belonging
   * to another workspace is simply not in the map, so its name cannot resolve
   * and an alias pointing at its id resolves to nothing either. There is no
   * separate cross-tenant check to forget.
   */
  const catalog = await db
    .select({ id: menuItems.id, name: menuItems.name, sellingPriceMillis: menuItems.sellingPriceMillis })
    .from(menuItems)
    .where(eq(menuItems.organizationId, tenant.organizationId));

  // Locations the *member* may use, not merely the organization's — so a
  // site-bound member cannot route rows to another branch via a location column.
  const allLocations = await listLocationOptions(tenant.organizationId);
  const locations = canAccessAllLocations(tenant.role)
    ? allLocations
    : allLocations.filter(option => option.id === tenant.locationId);

  const rows = rowsFromTable(table);

  const currency = values.currency ?? tenant.currency;

  /**
   * External ids this organization has already imported under this source.
   *
   * Loaded up front so duplicates are *reported* rather than discovered as a
   * constraint violation that would abort the whole transaction. Restricted to
   * the ids this plan would produce, so the query stays bounded no matter how
   * much history the workspace has.
   */
  const planWith = (existingKeys?: Iterable<string>) =>
    buildImportPlan(rows, {
      mapping,
      catalog,
      locations,
      defaultLocationId: values.locationId,
      currency,
      dateFormat: values.dateFormat,
      aliases: values.aliases,
      existingKeys,
    });

  const provisional = planWith();

  const candidateKeys = provisional.sales.map(sale => sale.idempotencyKey);
  const existing = candidateKeys.length
    ? await db
        .select({ externalId: sales.externalId })
        .from(sales)
        .where(
          and(
            eq(sales.organizationId, tenant.organizationId),
            eq(sales.source, "csv_import"),
            inArray(sales.externalId, candidateKeys),
          ),
        )
    : [];

  // Re-planned with what the database already holds, so `stats` reports the
  // duplicates as skipped rather than counting them as new revenue.
  const plan = existing.length
    ? planWith(existing.map(row => row.externalId).filter((id): id is string => id !== null))
    : provisional;

  return { plan, table, mapping, currency, catalog };
}

/** Row-level detail, trimmed for transport — the preview shows a sample, not the file. */
const PREVIEW_ROWS = 100;

export type ImportPreview = {
  headers: string[];
  delimiter: string;
  detectedMapping: ColumnMapping;
  /** First rows as parsed, so the user can see the file was read correctly. */
  sampleRows: RowOutcome[];
  stats: ImportPlan["stats"];
  unknownMenuItems: ImportPlan["unknownMenuItems"];
  unknownLocations: ImportPlan["unknownLocations"];
  /** Issue counts across the whole file, for the summary panel. */
  issueCounts: { code: string; label: string; severity: string; count: number }[];
  period: { from: string; to: string } | null;
  currency: string;
  truncated: boolean;
};

/**
 * Validates an upload and reports what an import would do, writing nothing.
 *
 * Requires `manage_sales` — the same permission as recording a sale, because an
 * import is a bulk version of exactly that, and the preview already reveals
 * which dishes and locations a workspace has.
 */
export async function previewSalesImport(input: unknown): Promise<ActionResult<ImportPreview>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_sales");

    const values = previewSalesImportInput.parse(input);
    await assertLocationAllowed(tenant, values.locationId);

    const { plan, table, currency } = await planImport(values, tenant);

    const counts = new Map<string, { code: string; label: string; severity: string; count: number }>();
    for (const row of plan.rows) {
      for (const entry of row.issues) {
        const existing = counts.get(entry.code);
        if (existing) existing.count += 1;
        else counts.set(entry.code, { code: entry.code, label: entry.message, severity: entry.severity, count: 1 });
      }
    }

    return actionOk({
      headers: table.headers,
      delimiter: table.delimiter,
      detectedMapping: suggestMapping(table.headers),
      sampleRows: plan.rows.slice(0, PREVIEW_ROWS),
      stats: plan.stats,
      unknownMenuItems: plan.unknownMenuItems,
      unknownLocations: plan.unknownLocations,
      issueCounts: [...counts.values()].sort((a, b) => b.count - a.count),
      period: plan.period ? { from: plan.period.from.toISOString(), to: plan.period.to.toISOString() } : null,
      currency,
      truncated: table.truncated,
    });
  } catch (error) {
    if (error instanceof CsvParseError) {
      return actionError(`Line ${error.line}: ${error.message}`);
    }
    return toActionError(error);
  }
}

/**
 * Writes the import.
 *
 * Everything lands in one transaction: the receipt row, every sale, every line
 * and the audit entry. If any statement fails the whole run disappears, which is
 * what makes a half-imported file impossible rather than merely unlikely.
 *
 * Sales are inserted with `onConflictDoNothing` on the idempotency index and the
 * inserted ids are read back. Two people importing the same file at the same
 * moment therefore produce one set of sales, and the loser records honestly that
 * its rows were already present — the pre-flight duplicate filter is a courtesy,
 * the index is the guarantee.
 */
export async function commitSalesImport(
  input: unknown,
): Promise<ActionResult<{ importId: string; importedRows: number; skippedRows: number; saleCount: number; totalMillis: number }>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_sales");

    const values = commitSalesImportInput.parse(input);
    await assertLocationAllowed(tenant, values.locationId);

    const { plan, mapping, currency, catalog } = await planImport(values, tenant);

    // Every location the plan actually targets is authorized, not just the
    // default: a location column could otherwise route rows to a branch the
    // member may not write to.
    for (const locationId of new Set(plan.sales.map(sale => sale.locationId))) {
      await assertLocationAllowed(tenant, locationId);
    }

    if (!plan.sales.length) {
      return actionError(
        plan.stats.duplicateRows > 0
          ? "Every sale in this file has already been imported."
          : "No rows in this file can be imported. Check the mapping and the reported problems.",
      );
    }

    /**
     * Stale-confirmation guard.
     *
     * The user confirmed a specific number of rows. If re-validating now yields
     * a different number — a dish was archived, another import landed first —
     * the difference is shown rather than silently written.
     */
    if (plan.stats.importedRows !== values.expectedImportedRows) {
      return actionError(
        `The file now imports ${plan.stats.importedRows} rows rather than ${values.expectedImportedRows}. Review the preview again before importing.`,
      );
    }

    const db = getDb();
    const priced = catalog.map(item => ({ id: item.id, name: item.name, sellingPriceMillis: item.sellingPriceMillis }));

    // Loaded once for the whole file: a 5,000-row import would otherwise
    // rebuild the same recipe graph 5,000 times.
    const units = await getOrganizationUnits(tenant.organizationId);
    const requirements = await loadConsumptionRequirements(tenant.organizationId, units);

    const result = await db.transaction(async tx => {
      const [receipt] = await tx
        .insert(salesImports)
        .values({
          organizationId: tenant.organizationId,
          locationId: values.locationId,
          adapter: "csv",
          source: "csv_import",
          status: "completed",
          filename: values.filename ?? null,
          // Byte length, not character count: accented menu names are multi-byte
          // in UTF-8, so `.length` would understate a French export's real size.
          fileSize: Buffer.byteLength(values.content, "utf8"),
          totalRows: plan.stats.totalRows,
          importedRows: plan.stats.importedRows,
          skippedRows: plan.stats.skippedRows,
          failedRows: plan.stats.skippedRows - plan.stats.duplicateRows,
          duplicateRows: plan.stats.duplicateRows,
          saleCount: plan.stats.saleCount,
          totalMillis: plan.stats.totalMillis,
          mapping: JSON.stringify({ mapping, dateFormat: values.dateFormat, currency, delimiter: values.delimiter ?? null }),
          issueSummary: JSON.stringify(summarizeIssues(plan)),
          createdBy: tenant.userId,
        })
        .returning({ id: salesImports.id });

      let insertedSales = 0;
      let insertedLines = 0;
      let insertedMillis = 0;
      let conflicted = 0;
      let consumptionMovements = 0;

      for (const sale of plan.sales) {
        // The index does the deciding. A concurrent run that already wrote this
        // externalId returns no row here, and its lines are skipped rather than
        // duplicated under a second sale.
        const [row] = await tx
          .insert(sales)
          .values({
            organizationId: tenant.organizationId,
            locationId: sale.locationId,
            source: "csv_import",
            status: "recorded",
            reference: sale.reference,
            // The dedupe key, not the till's raw id: every planned sale has one,
            // including those the file gave no id for.
            externalId: sale.idempotencyKey,
            totalMillis: sale.totalMillis,
            soldAt: sale.soldAt,
            createdBy: tenant.userId,
            importId: receipt.id,
          })
          .onConflictDoNothing({
            /**
             * Inference against the partial index, predicate included.
             *
             * `sales_org_source_external_uidx` carries
             * `WHERE external_id IS NOT NULL`, and Postgres will only infer a
             * partial index when the ON CONFLICT clause restates a predicate
             * implying it. Omitting `where` here raises "no unique or exclusion
             * constraint matching the ON CONFLICT specification" at runtime —
             * which TypeScript cannot catch, since the target is just a column
             * list to the driver. Drizzle emits this key between the target and
             * `do nothing`, which is the index-predicate position. Every
             * planned sale has an external id by construction, so it holds.
             */
            target: [sales.organizationId, sales.source, sales.externalId],
            where: sql`${sales.externalId} is not null`,
          })
          .returning({ id: sales.id });

        if (!row) {
          conflicted += 1;
          continue;
        }

        // Priced through the shared builder, so imported lines and manually
        // entered ones round and total identically. The unit price comes from
        // the file — `buildImportedSaleLines` never substitutes the menu's.
        const { lines, totalMillis } = buildImportedSaleLines(sale.lines, priced);

        await tx.insert(saleLines).values(
          lines.map(line => ({
            saleId: row.id,
            menuItemId: line.menuItemId,
            menuItemName: line.menuItemName,
            quantity: String(line.quantity),
            unitPriceMillis: line.unitPriceMillis,
            lineTotalMillis: line.lineTotalMillis,
            sortOrder: line.sortOrder,
          })),
        );

        insertedSales += 1;
        insertedLines += lines.length;
        insertedMillis += totalMillis;

        // Stock leaves the kitchen for imported sales exactly as it does for
        // manual ones — same module, same movement type. Dated to the sale, so
        // a backfilled file depletes stock on the day the food was served.
        consumptionMovements += await postSaleConsumption(tx, {
          organizationId: tenant.organizationId,
          locationId: sale.locationId,
          saleId: row.id,
          soldAt: sale.soldAt,
          performedBy: tenant.userId,
          soldLines: sale.lines.map(line => ({ menuItemId: line.menuItemId, quantity: line.quantity })),
          requirements,
        });
      }

      // Correct the receipt if concurrency changed the outcome, so the history
      // screen reports what was actually written rather than what was planned.
      if (conflicted > 0) {
        await tx
          .update(salesImports)
          .set({
            saleCount: insertedSales,
            importedRows: insertedLines,
            skippedRows: plan.stats.totalRows - insertedLines,
            duplicateRows: plan.stats.duplicateRows + (plan.stats.importedRows - insertedLines),
            totalMillis: insertedMillis,
            updatedAt: new Date(),
          })
          .where(eq(salesImports.id, receipt.id));
      }

      // Inside the transaction: this is money arriving in bulk, so the record of
      // who imported it must not be able to go missing while the sales stand.
      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "sales_imported",
          entityType: "sales_import",
          entityId: receipt.id,
          metadata: {
            locationId: values.locationId,
            source: "csv_import",
            adapter: "csv",
            filename: values.filename ?? null,
            totalRows: plan.stats.totalRows,
            importedRows: insertedLines,
            skippedRows: plan.stats.totalRows - insertedLines,
            duplicateRows: plan.stats.duplicateRows,
            saleCount: insertedSales,
            totalMillis: insertedMillis,
            consumptionMovements,
            currency,
            dateFormat: values.dateFormat,
            mapping,
          },
        },
        tx,
      );

      return {
        importId: receipt.id,
        importedRows: insertedLines,
        skippedRows: plan.stats.totalRows - insertedLines,
        saleCount: insertedSales,
        totalMillis: insertedMillis,
      };
    });

    revalidatePath("/dashboard");
    revalidatePath("/dashboard/sales");
    revalidatePath("/dashboard/sales/imports");
    revalidatePath("/dashboard/reports");

    return actionOk(result);
  } catch (error) {
    if (error instanceof CsvParseError) {
      return actionError(`Line ${error.line}: ${error.message}`);
    }
    return toActionError(error);
  }
}

/** Issue counts stored on the receipt, so history explains a run without the file. */
function summarizeIssues(plan: ImportPlan): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of plan.rows) {
    for (const entry of row.issues) {
      counts[entry.code] = (counts[entry.code] ?? 0) + 1;
    }
  }
  return counts;
}
