import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAuditAction, isAuditEntityType } from "@/lib/audit-actions";

/**
 * Structural guarantees for the sales import.
 *
 * These read the source rather than calling it, for the reason given in
 * `sales-integrity.test.ts`: the failures they guard against are silent ones. An
 * import that loses its organization filter writes plausible sales into the
 * wrong workspace. One that writes outside a transaction leaves half a file
 * behind. One that skips the permission check lets a cook post revenue. None of
 * those crashes, and Vitest has no Supabase session, request context or database
 * with which to catch them at runtime — so the choice is between checking the
 * source and checking nothing.
 *
 * The behaviour that *can* be tested for real — parsing, validation, pricing,
 * grouping, idempotency keys — is in `lib/csv.test.ts` and
 * `lib/sales-import.test.ts`, where it is exercised directly rather than
 * pattern-matched.
 */

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const ACTIONS = read("src/server/actions/sales-import.ts");
const LOCATIONS = read("src/server/queries/locations.ts");
const QUERIES = read("src/server/queries/sales-imports.ts");
const PIPELINE = read("src/lib/sales-import.ts");
const MIGRATION = read("drizzle/0007_sales_import.sql");
const RLS = read("supabase/rls.sql");
const SCHEMA = read("src/db/schema.ts");
const IMPORT_PAGE = read("src/app/dashboard/sales/import/page.tsx");
const DETAIL_PAGE = read("src/app/dashboard/sales/imports/[id]/page.tsx");

/** Splits a module into its exported functions, with their bodies. */
function exportedFunctions(source: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  const signature = /export\s+(?:async\s+)?function\s+(\w+)/g;

  let match: RegExpExecArray | null;
  while ((match = signature.exec(source)) !== null) {
    const start = match.index;
    const next = source.indexOf("\nexport ", start + 1);
    found.push({ name: match[1], body: source.slice(start, next === -1 ? source.length : next) });
  }
  return found;
}

/** Strips comments, so prose about a rule is never mistaken for the rule. */
function code(body: string) {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const actions = exportedFunctions(ACTIONS);
const queries = exportedFunctions(QUERIES);
const commit = actions.find(fn => fn.name === "commitSalesImport")!;
const preview = actions.find(fn => fn.name === "previewSalesImport")!;

describe("the import modules parse", () => {
  it("exposes a preview and a commit", () => {
    expect(actions.map(fn => fn.name)).toEqual(expect.arrayContaining(["previewSalesImport", "commitSalesImport"]));
  });

  it("exposes the history queries", () => {
    expect(queries.map(fn => fn.name)).toEqual(
      expect.arrayContaining(["listSalesImports", "getSalesImport", "listSalesForImport"]),
    );
  });
});

describe("permission enforcement", () => {
  it("both actions require manage_sales", () => {
    for (const fn of actions) {
      expect(code(fn.body), `${fn.name} must require a permission`).toMatch(
        /requirePermission\(tenant\.role, "manage_sales"\)/,
      );
    }
  });

  it("establishes the tenant before checking anything", () => {
    for (const fn of actions) {
      const body = code(fn.body);
      expect(body.indexOf("requireTenant"), `${fn.name}`).toBeLessThan(body.indexOf("requirePermission"));
    }
  });

  it("checks the permission before parsing input", () => {
    for (const fn of actions) {
      const body = code(fn.body);
      expect(body.indexOf("requirePermission"), `${fn.name}`).toBeLessThan(body.indexOf("Input.parse"));
    }
  });

  it("uses the same permission as recording a sale by hand", () => {
    // An import is a bulk version of manual entry; a separate, weaker
    // permission would be a way around the narrower one.
    const permissions = read("src/lib/permissions.ts");
    expect(permissions).toMatch(/manage_sales: \["owner", "manager"\]/);
  });

  it("checks the permission on the page as well, so the screen is not offered blindly", () => {
    expect(IMPORT_PAGE).toMatch(/hasPermission\(tenant\.role, "manage_sales"\)/);
  });
});

describe("tenant isolation", () => {
  it("resolves the menu catalog scoped to the caller's organization", () => {
    // This is the import's tenant boundary: a dish from another workspace is
    // not in the catalog, so neither its name nor its id can resolve.
    expect(code(ACTIONS)).toMatch(/eq\(menuItems\.organizationId, tenant\.organizationId\)/);
  });

  it("never loads menu items without an organization filter", () => {
    const selects = code(ACTIONS).match(/\.from\(menuItems\)[\s\S]*?;/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const statement of selects) {
      expect(statement).toMatch(/organizationId/);
    }
  });

  it("checks idempotency within the organization, not globally", () => {
    // A global check would let one tenant's ticket suppress another's sale.
    const lookup = code(ACTIONS).slice(code(ACTIONS).indexOf("candidateKeys"));
    expect(lookup).toMatch(/eq\(sales\.organizationId, tenant\.organizationId\)/);
  });

  it("stamps every written sale with the caller's own organization", () => {
    const transaction = code(commit.body).slice(code(commit.body).indexOf("db.transaction"));
    expect(transaction).toMatch(/organizationId: tenant\.organizationId/);
  });

  it("never takes the organization from the request", () => {
    expect(code(ACTIONS)).not.toMatch(/values\.organizationId/);
  });

  it("scopes every history query by organization", () => {
    for (const fn of queries) {
      expect(code(fn.body), `${fn.name} must constrain the organization`).toMatch(/organizationId/);
    }
  });

  it("scopes a single import lookup in the WHERE clause, not after the fetch", () => {
    const getOne = queries.find(fn => fn.name === "getSalesImport")!;
    expect(code(getOne.body)).toMatch(
      /eq\(salesImports\.id, importId\),\s*eq\(salesImports\.organizationId, organizationId\)/,
    );
  });
});

describe("location authorization", () => {
  it("both actions authorize the target location", () => {
    for (const fn of actions) {
      expect(code(fn.body), `${fn.name} must authorize its location`).toMatch(/assertLocationAllowed/);
    }
  });

  it("verifies the location belongs to the organization", () => {
    // The rule moved into `queries/locations` so every location-bearing mutation
    // shares one definition; these assert it where it now lives, and that this
    // file delegates to it rather than carrying a second copy that could drift.
    expect(code(LOCATIONS)).toMatch(/ownsLocation\(tenant\.organizationId, locationId\)/);
    const guard = ACTIONS.slice(ACTIONS.indexOf("async function assertLocationAllowed"));
    expect(code(guard.slice(0, guard.indexOf("\n}")))).toMatch(/assertMemberLocation\(tenant, locationId/);
  });

  it("pins a site-bound member to their own location", () => {
    expect(code(LOCATIONS)).toMatch(
      /!canAccessAllLocations\(tenant\.role\)\s*&&\s*tenant\.locationId !== locationId/,
    );
  });

  it("authorizes every location the file targets, not only the chosen one", () => {
    // A location column could otherwise route rows to a branch the member may
    // not write to, bypassing the check on the default location.
    expect(code(commit.body)).toMatch(/for \(const locationId of new Set\(plan\.sales\.map\(sale => sale\.locationId\)\)\)/);
  });

  it("narrows the location list a site-bound member can resolve names against", () => {
    const planner = ACTIONS.slice(ACTIONS.indexOf("async function planImport"));
    expect(code(planner)).toMatch(/canAccessAllLocations\(tenant\.role\)[\s\S]{0,200}?filter\(option => option\.id === tenant\.locationId\)/);
  });

  it("hides an import run from a member of another site", () => {
    expect(DETAIL_PAGE).toMatch(/!canAccessAllLocations\(tenant\.role\) && tenant\.locationId !== entry\.locationId/);
  });
});

describe("atomicity", () => {
  it("writes the import in a single transaction", () => {
    expect(code(commit.body)).toMatch(/db\.transaction\(async tx =>/);
  });

  it("writes the receipt, the sales and the lines inside that transaction", () => {
    const transaction = code(commit.body).slice(code(commit.body).indexOf("db.transaction"));
    expect(transaction).toMatch(/insert\(salesImports\)/);
    expect(transaction).toMatch(/insert\(sales\)/);
    expect(transaction).toMatch(/insert\(saleLines\)/);
  });

  it("performs no insert outside the transaction", () => {
    // An insert before `db.transaction` would survive a rollback, which is
    // exactly the half-imported state the feature must make impossible.
    const body = code(commit.body);
    const before = body.slice(0, body.indexOf("db.transaction"));
    expect(before).not.toMatch(/\.insert\(/);
  });

  it("uses the transaction handle for every write, never the pooled client", () => {
    const transaction = code(commit.body).slice(code(commit.body).indexOf("db.transaction"));
    const inserts = transaction.match(/\b(\w+)\.insert\(/g) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    for (const insert of inserts) {
      expect(insert, "a write inside the transaction used the pooled client").toMatch(/^tx\.insert\(/);
    }
  });

  it("writes nothing at all in the preview", () => {
    expect(code(preview.body)).not.toMatch(/\.insert\(|\.update\(|\.delete\(|transaction\(/);
  });
});

describe("audit logging", () => {
  it("records an audit entry", () => {
    expect(code(commit.body)).toMatch(/recordAudit\(/);
  });

  it("records it inside the transaction", () => {
    // Outside it, a rolled-back import could leave a log claiming revenue that
    // does not exist — or a committed one with no record of who ran it.
    const body = code(commit.body);
    expect(body.indexOf("recordAudit")).toBeGreaterThan(body.indexOf("db.transaction"));
    expect(body).toMatch(/recordAudit\([\s\S]*?\},\s*tx,\s*\)/);
  });

  it("audits under a defined vocabulary member", () => {
    expect(code(ACTIONS)).toMatch(/action: "sales_imported"/);
    expect(code(ACTIONS)).toMatch(/entityType: "sales_import"/);
    expect(isAuditAction("sales_imported")).toBe(true);
    expect(isAuditEntityType("sales_import")).toBe(true);
  });

  it("records enough metadata to reconstruct the run", () => {
    for (const field of [
      "locationId",
      "source",
      "adapter",
      "filename",
      "totalRows",
      "importedRows",
      "skippedRows",
      "duplicateRows",
      "saleCount",
      "totalMillis",
      "mapping",
    ]) {
      expect(code(commit.body), `audit metadata should carry ${field}`).toMatch(new RegExp(`\\b${field}[:,]`));
    }
  });

  it("does not audit a preview, which changes nothing", () => {
    expect(code(preview.body)).not.toMatch(/recordAudit\(/);
  });
});

describe("idempotency", () => {
  it("gives every planned sale a key rather than only those the till identified", () => {
    const planner = PIPELINE.slice(PIPELINE.indexOf("const idempotencyKey"));
    expect(code(planner.slice(0, planner.indexOf("\n\n")))).toMatch(/stableHash/);
  });

  it("derives the fallback key from the sale's contents, not the file or the clock", () => {
    // A key derived from the filename or row position would not recognise the
    // same sales arriving from a re-exported file.
    const planner = PIPELINE.slice(PIPELINE.indexOf("const idempotencyKey"), PIPELINE.indexOf("// Already in the database"));
    expect(planner).toMatch(/group\.locationId/);
    expect(planner).toMatch(/group\.soldAt\.toISOString\(\)/);
    expect(planner).toMatch(/group\.lines\.map/);
    expect(planner).not.toMatch(/filename|Date\.now|Math\.random/);
  });

  it("writes the key into the column the unique index covers", () => {
    expect(code(commit.body)).toMatch(/externalId: sale\.idempotencyKey/);
  });

  it("lets the database decide, rather than trusting the pre-flight check", () => {
    // Two concurrent imports would both pass a read-then-write check; the index
    // is what actually prevents the double insert.
    expect(code(commit.body)).toMatch(/onConflictDoNothing\(/);
    expect(code(commit.body)).toMatch(/target: \[sales\.organizationId, sales\.source, sales\.externalId\]/);
  });

  it("restates the index predicate so Postgres can infer the partial index", () => {
    // Without the predicate this raises "no unique or exclusion constraint
    // matching the ON CONFLICT specification" at runtime.
    expect(code(commit.body)).toMatch(/where: sql`\$\{sales\.externalId\} is not null`/);
  });

  it("skips the lines of a sale that lost the conflict", () => {
    // Inserting lines for a sale that was not created would attach them to
    // nothing, or worse, duplicate an existing sale's lines.
    expect(code(commit.body)).toMatch(/if \(!row\) \{[\s\S]{0,120}continue;/);
  });

  it("reconciles the receipt when concurrency changed the outcome", () => {
    expect(code(commit.body)).toMatch(/if \(conflicted > 0\)/);
    expect(code(commit.body)).toMatch(/update\(salesImports\)/);
  });
});

describe("historical pricing", () => {
  it("prices imported lines through the shared builder", () => {
    expect(code(commit.body)).toMatch(/buildImportedSaleLines\(/);
  });

  it("never substitutes the menu price for a price the file supplied", () => {
    const builder = read("src/lib/sales.ts");
    const fn = builder.slice(builder.indexOf("export function buildImportedSaleLines"));
    // The line takes the imported price verbatim. Reading `sellingPriceMillis`
    // here would silently re-price history.
    expect(code(fn)).toMatch(/unitPriceMillis: item\.unitPriceMillis/);
    expect(code(fn)).not.toMatch(/unitPriceMillis: menuItem\.sellingPriceMillis/);
  });

  it("flags the one case where a menu price is used", () => {
    // A row with no price at all falls back to the menu, which is the only
    // non-historical figure an import can produce — so it is reported.
    expect(code(PIPELINE)).toMatch(/pricedFrom = "menu"/);
    expect(code(PIPELINE)).toMatch(/issue\("price_defaulted"\)/);
  });
});

describe("the server does not trust the client", () => {
  it("re-parses the file rather than accepting a plan", () => {
    // The preview is computed in the browser for speed; if the commit accepted
    // it, a tampered request could import rows the validator rejected.
    expect(code(commit.body)).toMatch(/planImport\(values, tenant\)/);
    expect(code(ACTIONS)).toMatch(/parseCsv\(values\.content/);
  });

  it("shares one planner between preview and commit", () => {
    expect(code(preview.body)).toMatch(/planImport\(values, tenant\)/);
  });

  it("refuses a confirmation that no longer matches the file", () => {
    expect(code(commit.body)).toMatch(/plan\.stats\.importedRows !== values\.expectedImportedRows/);
  });

  it("rejects a mapping naming a column the file does not have", () => {
    const planner = ACTIONS.slice(ACTIONS.indexOf("async function planImport"));
    expect(code(planner)).toMatch(/The file has no column named/);
  });

  it("refuses to run without the required fields mapped", () => {
    const planner = ACTIONS.slice(ACTIONS.indexOf("async function planImport"));
    expect(code(planner)).toMatch(/missingRequiredFields\(mapping\)/);
  });

  it("bounds the size of an upload", () => {
    const validation = read("src/lib/validation.ts");
    expect(validation).toMatch(/IMPORT_MAX_BYTES/);
    expect(validation).toMatch(/IMPORT_MAX_ROWS/);
    expect(code(ACTIONS)).toMatch(/maxRows: IMPORT_MAX_ROWS/);
  });
});

describe("nothing is created implicitly", () => {
  it("the import never inserts a menu item", () => {
    expect(code(ACTIONS)).not.toMatch(/insert\(\s*menuItems/);
    expect(code(PIPELINE)).not.toMatch(/insert\(/);
  });

  it("the import never inserts an ingredient or a recipe", () => {
    expect(code(ACTIONS)).not.toMatch(/insert\(\s*(ingredients|recipes|menuItemLines)/);
  });

  it("an unmatched name is reported for the user to resolve", () => {
    expect(code(PIPELINE)).toMatch(/issue\("unknown_menu_item"/);
    expect(code(PIPELINE)).toMatch(/unknownMenuItems/);
  });

  it("resolves an alias against the catalog rather than trusting the id", () => {
    // An alias naming another workspace's menu item id must not resolve; the
    // catalog lookup is what makes that true.
    expect(code(PIPELINE)).toMatch(/aliasTarget \? byId\.get\(aliasTarget\)/);
  });
});

describe("imports stay out of the stock ledger", () => {
  // Same rule as manual sales: consumption is inferred from recipes on read.
  // Posting inference into the ledger would compare a stock count against a
  // figure derived from itself and always find zero variance.
  for (const modulePath of ["src/server/actions/sales-import.ts", "src/lib/sales-import.ts", "src/server/queries/sales-imports.ts"]) {
    it(`${modulePath} writes no stock movements`, () => {
      const source = code(read(modulePath));
      expect(source).not.toMatch(/stockMovements/);
      expect(source).not.toMatch(/update\(\s*ingredients\s*\)/);
    });
  }
});

describe("the import is recognisable as such", () => {
  it("marks every imported sale with the csv_import source", () => {
    expect(code(commit.body)).toMatch(/source: "csv_import"/);
  });

  it("ties each sale back to the run that created it", () => {
    expect(code(commit.body)).toMatch(/importId: receipt\.id/);
  });

  it("records the adapter, so a future POS integration is distinguishable", () => {
    expect(code(commit.body)).toMatch(/adapter: "csv"/);
  });
});

describe("database constraints", () => {
  it("creates the import receipt table", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "sales_imports"/);
  });

  it("cascades a deleted organization to its import history", () => {
    expect(MIGRATION).toMatch(/"sales_imports_organization_id_organizations_id_fk"[\s\S]*?ON DELETE cascade/);
  });

  it("keeps the sales when an import receipt is deleted", () => {
    // CASCADE here would delete revenue along with the bookkeeping row.
    expect(MIGRATION).toMatch(/"sales_import_id_sales_imports_id_fk"[\s\S]*?ON DELETE set null/);
  });

  it("refuses a receipt whose counts do not add up", () => {
    expect(MIGRATION).toMatch(/CHECK \("imported_rows" \+ "skipped_rows" <= "total_rows"\)/);
  });

  it("refuses negative counts", () => {
    expect(MIGRATION).toMatch(/sales_imports_counts_non_negative/);
  });

  it("indexes the history listing", () => {
    expect(MIGRATION).toMatch(/"sales_imports_org_idx"[^;]*"organization_id", "created_at"/);
  });

  it("indexes the sales a run created", () => {
    expect(MIGRATION).toMatch(/"sales_import_idx" ON "sales" \("import_id"\)/);
  });

  it("stores timestamps with a timezone", () => {
    expect(MIGRATION).toMatch(/"created_at" timestamp with time zone/);
  });

  it("is re-runnable, like every other migration in this project", () => {
    // Each object is guarded, so applying the file twice is a no-op rather
    // than an error that leaves later statements unapplied.
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(MIGRATION).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(MIGRATION).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
  });

  it("is registered in the migration journal", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: { tag: string }[] };
    expect(journal.entries.map(entry => entry.tag)).toContain("0007_sales_import");
  });

  it("declares the table in the Drizzle schema too", () => {
    expect(SCHEMA).toMatch(/export const salesImports = pgTable\("sales_imports"/);
    expect(SCHEMA).toMatch(/importId: uuid\("import_id"\)/);
  });
});

describe("row level security", () => {
  it("enables RLS on the import table", () => {
    expect(RLS).toMatch(/alter table public\.sales_imports\s+enable row level security/);
  });

  it("covers it with the organization-scoped policy loop", () => {
    const loop = RLS.slice(RLS.indexOf("foreach target in array"), RLS.indexOf("end loop"));
    expect(loop).toMatch(/'sales_imports'/);
  });
});
