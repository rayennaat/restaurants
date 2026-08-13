import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural guarantees for sales.
 *
 * These read the source rather than calling it. The reasoning is the same as in
 * `audit-coverage.test.ts`: the failures guarded against here are silent ones.
 * A revenue query that forgets its organization filter returns plausible
 * numbers — someone else's. A void that stops being excluded inflates takings
 * quietly. Neither shows up as a crash, and Vitest has no Supabase session,
 * request context or database with which to catch them at runtime.
 *
 * So each rule is asserted against the code that must obey it. This cannot
 * prove the query planner does what the SQL says, but it does prove nobody
 * dropped the clause — which is the regression that actually happens.
 *
 * The arithmetic these sit on top of is tested for real in `lib/sales.test.ts`
 * and `lib/consumption.test.ts`; runtime behaviour against live data (rows
 * landing, rollbacks unwinding, the freeze trigger firing) is covered by a
 * database probe.
 */

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const QUERIES = read("src/server/queries/sales.ts");
const ACTIONS = read("src/server/actions/sales.ts");
const LOCATIONS = read("src/server/queries/locations.ts");
const MIGRATION = read("drizzle/0006_sales.sql");
const RLS = read("supabase/rls.sql");

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

const queryFunctions = exportedFunctions(QUERIES);
const actionFunctions = exportedFunctions(ACTIONS);

/** Strips comments, so prose about a rule is never mistaken for the rule. */
function code(body: string) {
  return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the sales modules parse", () => {
  it("finds the exported queries", () => {
    expect(queryFunctions.map(fn => fn.name)).toEqual(
      expect.arrayContaining(["getSalesSummary", "getSalesByMenuItem", "getSalesTrend", "getSalesByLocation", "getSale"]),
    );
  });

  it("finds the exported actions", () => {
    expect(actionFunctions.map(fn => fn.name)).toEqual(expect.arrayContaining(["recordSale", "voidSale"]));
  });
});

describe("tenant isolation", () => {
  it("filters by organization inside the shared scope helper", () => {
    // Most queries inherit their tenant filter from here, so this is the single
    // clause the majority of sales reporting depends on.
    const helper = QUERIES.slice(QUERIES.indexOf("function scopeConditions"));
    expect(code(helper.slice(0, helper.indexOf("\n}")))).toMatch(/eq\(sales\.organizationId, scope\.organizationId\)/);
  });

  // Every query is scoped by organization — either naming the filter itself, or
  // delegating to the helper asserted above. A query doing neither is
  // unscoped, which is the leak this guards against.
  for (const fn of queryFunctions) {
    it(`${fn.name} constrains the organization`, () => {
      expect(code(fn.body)).toMatch(/organizationId|scopeConditions\(/);
    });
  }

  it("scopes a single sale lookup in the WHERE clause, not after the fetch", () => {
    // Filtering in JS after loading would still leak existence through timing
    // and through a 200-vs-404 difference.
    const getSale = queryFunctions.find(fn => fn.name === "getSale")!;
    expect(code(getSale.body)).toMatch(/eq\(sales\.id, saleId\),\s*eq\(sales\.organizationId, organizationId\)/);
  });

  it("resolves the menu catalog scoped to the caller's organization", () => {
    // This is what makes a foreign menu item id unresolvable rather than
    // priced, so it is the tenant boundary of the write path.
    expect(code(ACTIONS)).toMatch(/eq\(menuItems\.organizationId, tenant\.organizationId\)/);
  });

  it("checks idempotency within the organization, not globally", () => {
    // A global (source, externalId) check would let one tenant's ticket number
    // suppress another's sale.
    const record = actionFunctions.find(fn => fn.name === "recordSale")!;
    const idempotency = code(record.body).slice(code(record.body).indexOf("values.externalId"));
    expect(idempotency).toMatch(/eq\(sales\.organizationId, tenant\.organizationId\)/);
  });
});

describe("voided sales are excluded from revenue", () => {
  /** Aggregates that produce money or units, and so must ignore voids. */
  const REVENUE_QUERIES = [
    "getSalesSummary",
    "getTodaySales",
    "getSalesByMenuItem",
    "getSalesTrend",
    "getSalesByLocation",
    "getSoldQuantities",
  ];

  /**
   * Views that deliberately include voided rows, each with a reason. A query
   * added here is a decision visible in the diff.
   */
  const INCLUDES_VOIDS: Record<string, string> = {
    listSales: "Ledger view: a void must stay visible and explicable, not vanish.",
    getSale: "Detail view: the void reason is the point of opening it.",
    hasAnySales: "Empty-state check: a workspace whose only sale was voided has still used the feature.",
    getTheoreticalConsumption: "Delegates to getSoldQuantities, which filters.",
  };

  for (const name of REVENUE_QUERIES) {
    it(`${name} counts recorded sales only`, () => {
      const fn = queryFunctions.find(entry => entry.name === name);
      expect(fn, `${name} not found — was it renamed?`).toBeDefined();
      // Either through the shared scope helper or by naming the filter directly.
      expect(code(fn!.body)).toMatch(/scopeConditions|RECORDED/);
    });
  }

  it("accounts for every exported query as either filtering or deliberately not", () => {
    const accounted = new Set([...REVENUE_QUERIES, ...Object.keys(INCLUDES_VOIDS)]);
    const unaccounted = queryFunctions.map(fn => fn.name).filter(name => !accounted.has(name));
    expect(unaccounted).toEqual([]);
  });

  it("defines the recorded filter once", () => {
    expect(QUERIES).toMatch(/const RECORDED = eq\(sales\.status, "recorded"\)/);
  });

  it("applies the recorded filter inside the shared scope helper", () => {
    const helper = QUERIES.slice(QUERIES.indexOf("function scopeConditions"));
    expect(code(helper.slice(0, helper.indexOf("\n}")))).toMatch(/RECORDED/);
  });

  it("voids by flagging the row rather than deleting it", () => {
    const voidSale = actionFunctions.find(fn => fn.name === "voidSale")!;
    expect(code(voidSale.body)).toMatch(/status: "voided"/);
    expect(code(voidSale.body)).not.toMatch(/\.delete\(/);
  });

  it("guards the void against a concurrent second void", () => {
    // Conditioning the UPDATE on the status just read is what stops two people
    // both winning and writing two audit entries for one state change.
    const voidSale = actionFunctions.find(fn => fn.name === "voidSale")!;
    expect(code(voidSale.body)).toMatch(/eq\(sales\.status, "recorded"\)/);
  });
});

describe("historical pricing", () => {
  it("never values a sale line from the live menu price", () => {
    // One reference to the live price exists, aliased `currentPriceMillis` on
    // the detail query, purely so the screen can say "this dish costs more
    // now". Any second reference would be revenue being recomputed.
    const references = code(QUERIES).match(/menuItems\.sellingPriceMillis/g) ?? [];
    expect(references).toHaveLength(1);
    expect(code(QUERIES)).toMatch(/currentPriceMillis: menuItems\.sellingPriceMillis/);
  });

  it("aggregates revenue from the snapshotted line and sale totals", () => {
    expect(code(QUERIES)).toMatch(/sum\(\$\{saleLines\.lineTotalMillis\}\)|sum\(\$\{sales\.totalMillis\}\)/);
  });

  it("takes the price from the server-side catalog, never from the request", () => {
    const record = actionFunctions.find(fn => fn.name === "recordSale")!;
    expect(code(record.body)).toMatch(/buildSaleLines\(values\.items, catalog\)/);
    // A price arriving from the client would have to be read off `values`.
    expect(code(record.body)).not.toMatch(/values\.items\[[^\]]*\]\.(unitPrice|price)/);
    expect(code(record.body)).not.toMatch(/item\.(unitPriceMillis|priceMillis|sellingPriceMillis)/);
  });

  it("keeps sale lines immutable in the database", () => {
    // The application does not edit lines; the trigger is what makes that a
    // guarantee rather than a convention, including against manual SQL.
    expect(MIGRATION).toMatch(/CREATE TRIGGER sale_lines_freeze_trg/);
    expect(MIGRATION).toMatch(/BEFORE UPDATE ON public\.sale_lines/);
  });

  it("refuses to delete a menu item that has sales against it", () => {
    expect(MIGRATION).toMatch(/REFERENCES "public"\."menu_items"\("id"\) ON DELETE restrict/);
  });

  it("snapshots the item name on the line so a rename cannot rewrite a receipt", () => {
    expect(MIGRATION).toMatch(/"menu_item_name" text NOT NULL/);
  });
});

describe("import idempotency", () => {
  it("has a unique index on (organization, source, external id)", () => {
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX[^;]*"sales_org_source_external_uidx"[\s\S]*?"organization_id", "source", "external_id"/);
  });

  it("makes that index partial so manual sales are unconstrained", () => {
    const index = MIGRATION.slice(MIGRATION.indexOf("sales_org_source_external_uidx"));
    expect(index.slice(0, index.indexOf(";"))).toMatch(/WHERE "external_id" IS NOT NULL/);
  });

  it("reports a repeat as a duplicate rather than an error", () => {
    // An importer re-running yesterday's export wants a no-op it can count, not
    // a failure it has to interpret.
    const record = actionFunctions.find(fn => fn.name === "recordSale")!;
    expect(code(record.body)).toMatch(/duplicate: true/);
    expect(code(record.body)).toMatch(/duplicate: false/);
  });

  it("scopes the duplicate check by source as well as external id", () => {
    // The same ticket number from a CSV and from a POS are different sales.
    const record = actionFunctions.find(fn => fn.name === "recordSale")!;
    expect(code(record.body)).toMatch(/eq\(sales\.source, values\.source\)/);
    expect(code(record.body)).toMatch(/eq\(sales\.externalId, values\.externalId\)/);
  });
});

describe("location authorization", () => {
  it("both mutations check the location before writing", () => {
    for (const fn of actionFunctions) {
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

  it("authorizes a void against the sale's stored location, not a supplied one", () => {
    // Taking the location from the request would let a site-bound member void
    // another site's sale by naming their own.
    const voidSale = actionFunctions.find(fn => fn.name === "voidSale")!;
    expect(code(voidSale.body)).toMatch(/assertLocationAllowed\(tenant, existing\.locationId\)/);
  });
});

describe("permission enforcement", () => {
  it("both mutations require manage_sales", () => {
    for (const fn of actionFunctions) {
      expect(code(fn.body), `${fn.name} must require a permission`).toMatch(
        /requirePermission\(tenant\.role, "manage_sales"\)/,
      );
    }
  });

  it("establishes the tenant before checking anything", () => {
    for (const fn of actionFunctions) {
      const body = code(fn.body);
      expect(body.indexOf("requireTenant"), `${fn.name}`).toBeLessThan(body.indexOf("requirePermission"));
    }
  });

  it("checks the permission before parsing input", () => {
    // Cheapest rejection first, and it keeps validation messages from being an
    // oracle for someone who may not use the feature at all.
    for (const fn of actionFunctions) {
      const body = code(fn.body);
      expect(body.indexOf("requirePermission"), `${fn.name}`).toBeLessThan(body.indexOf("Input.parse"));
    }
  });
});

describe("atomicity and audit", () => {
  it("writes each mutation in a single transaction", () => {
    for (const fn of actionFunctions) {
      expect(code(fn.body), `${fn.name} must be transactional`).toMatch(/db\.transaction\(async tx =>/);
    }
  });

  it("records the audit entry inside that transaction", () => {
    // Outside it, a rolled-back sale could leave an audit row claiming revenue
    // that does not exist — or worse, a committed sale with no record of who
    // entered it.
    for (const fn of actionFunctions) {
      const body = code(fn.body);
      expect(body.indexOf("recordAudit"), `${fn.name}`).toBeGreaterThan(body.indexOf("db.transaction"));
      expect(body, `${fn.name} must pass the transaction to recordAudit`).toMatch(/recordAudit\([\s\S]*?\},\s*tx,\s*\)/);
    }
  });

  it("inserts the sale and its lines in the same transaction", () => {
    const record = actionFunctions.find(fn => fn.name === "recordSale")!;
    const transaction = code(record.body).slice(code(record.body).indexOf("db.transaction"));
    expect(transaction).toMatch(/insert\(sales\)/);
    expect(transaction).toMatch(/insert\(saleLines\)/);
  });

  it("audits under the actions the audit vocabulary defines", () => {
    expect(code(ACTIONS)).toMatch(/action: "sale_recorded"/);
    expect(code(ACTIONS)).toMatch(/action: "sale_voided"/);
    const vocabulary = read("src/lib/audit-actions.ts");
    expect(vocabulary).toMatch(/"sale_recorded"/);
    expect(vocabulary).toMatch(/"sale_voided"/);
  });

  it("records enough metadata to reconstruct what happened", () => {
    const record = actionFunctions.find(fn => fn.name === "recordSale")!;
    for (const field of ["locationId", "source", "externalId", "lineCount", "unitsSold", "totalMillis"]) {
      // Either `field: value` or ES shorthand.
      expect(code(record.body), `audit metadata should carry ${field}`).toMatch(new RegExp(`\\b${field}[:,]`));
    }
  });

  it("records the reason and the money reversed when voiding", () => {
    const voidSale = actionFunctions.find(fn => fn.name === "voidSale")!;
    expect(code(voidSale.body)).toMatch(/reason: values\.reason/);
    expect(code(voidSale.body)).toMatch(/reversedTotalMillis/);
  });
});

describe("selling depletes stock through one shared path", () => {
  /**
   * Consumption posting lives in `server/sale-consumption` and nowhere else.
   *
   * An earlier version of this suite asserted the opposite — that sales write
   * no movements at all — on the reasoning that posting inference would make a
   * stock count "compare a figure against itself". That was wrong: variance is
   * `counted − system`, and `counted` is typed by a human after walking the
   * shelves, so the two sides stay independent whatever the ledger holds.
   * Without posting, the ledger only ever rises and a count reports the whole
   * period's expected usage as variance.
   *
   * What these tests protect instead is that the depletion has exactly one
   * definition. A second `insert(stockMovements)` in a sales module would be a
   * parallel consumption system, which is the failure actually worth guarding.
   */
  const MUST_DELEGATE = [
    "src/server/queries/sales.ts",
    "src/lib/sales.ts",
    "src/lib/consumption.ts",
    "src/lib/sales-import.ts",
  ];

  for (const modulePath of MUST_DELEGATE) {
    it(`${modulePath} writes no stock movements of its own`, () => {
      const source = code(read(modulePath));
      expect(source).not.toMatch(/insert\(\s*stockMovements/);
      expect(source).not.toMatch(/update\(\s*ingredients\s*\)/);
    });
  }

  it("keeps the pure consumption engine free of database access", () => {
    // It stays a pure expansion; only the server module decides to post it.
    const source = code(read("src/lib/consumption.ts"));
    expect(source).not.toMatch(/stockMovements|getDb\(/);
  });

  for (const modulePath of ["src/server/actions/sales.ts", "src/server/actions/sales-import.ts"]) {
    it(`${modulePath} posts consumption through the shared module`, () => {
      const source = code(read(modulePath));
      expect(source).toMatch(/postSaleConsumption\(/);
      // The movement rows themselves are built in one place only.
      expect(source).not.toMatch(/insert\(\s*stockMovements/);
    });
  }

  it("writes the consumption movements inside the sale's own transaction", () => {
    // Outside it, a rolled-back sale would leave stock depleted for a sale that
    // never happened.
    const record = actionFunctions.find(fn => fn.name === "recordSale")!;
    const transaction = code(record.body).slice(code(record.body).indexOf("db.transaction"));
    expect(transaction).toMatch(/postSaleConsumption\(tx, \{/);
  });

  it("reverses consumption when a sale is voided", () => {
    const voidSale = actionFunctions.find(fn => fn.name === "voidSale")!;
    const transaction = code(voidSale.body).slice(code(voidSale.body).indexOf("db.transaction"));
    expect(transaction).toMatch(/reverseSaleConsumption\(tx, \{/);
  });

  it("reverses by writing opposite movements rather than deleting", () => {
    // The ledger is append-only: a void is a correction that stays visible.
    const source = code(read("src/server/sale-consumption.ts"));
    const reversal = source.slice(source.indexOf("export async function reverseSaleConsumption"));
    expect(reversal).toMatch(/insert\(stockMovements\)/);
    expect(reversal).not.toMatch(/\.delete\(/);
    expect(reversal).toMatch(/String\(-Number\(row\.quantity\)\)/);
  });

  it("reverses only what the sale itself posted", () => {
    // Matching on referenceId alone would pick up the reversal rows too, so
    // voiding twice would re-credit the stock.
    const source = code(read("src/server/sale-consumption.ts"));
    const reversal = source.slice(source.indexOf("export async function reverseSaleConsumption"));
    expect(reversal).toMatch(/eq\(stockMovements\.referenceType, "sale"\)/);
    expect(reversal).toMatch(/eq\(stockMovements\.type, "sale_consumption"\)/);
    expect(reversal).toMatch(/eq\(stockMovements\.organizationId, input\.organizationId\)/);
  });

  it("tags consumption as an inference, distinguishable from observed movement", () => {
    // `purchase`, `waste` and `stock_count_adjustment` are measured; this is
    // derived from a recipe. The type is what keeps them separable.
    const source = code(read("src/server/sale-consumption.ts"));
    expect(source).toMatch(/type: "sale_consumption" as const/);
    expect(source).toMatch(/referenceType: "sale"/);
  });

  it("dates the movements to the sale, not to the import", () => {
    // A backfilled file must deplete stock on the day the food was served.
    const source = code(read("src/server/sale-consumption.ts"));
    expect(source).toMatch(/occurredAt: input\.soldAt/);
  });

  it("scopes the recipe expansion to the caller's organization", () => {
    const source = code(read("src/server/sale-consumption.ts"));
    const loader = source.slice(source.indexOf("export async function loadConsumptionRequirements"));
    expect(loader).toMatch(/eq\(menuItems\.organizationId, organizationId\)/);
  });

  it("derives consumption on read from the same recipe graph that prices the menu", () => {
    const consumption = code(QUERIES).slice(code(QUERIES).indexOf("function getTheoreticalConsumption"));
    expect(consumption).toMatch(/getPreparationGraph/);
    expect(consumption).toMatch(/expandMenuItemConsumption/);
    expect(consumption).toMatch(/calculateTheoreticalConsumption/);
  });

  it("posts through the same expansion the reports use", () => {
    // Two expansions would let the ledger and the report disagree about what a
    // burger contains.
    const source = code(read("src/server/sale-consumption.ts"));
    expect(source).toMatch(/expandMenuItemConsumption/);
    expect(source).toMatch(/getPreparationGraph/);
  });

  it("reports sold units that no recipe accounts for", () => {
    // Without this, an implausibly low consumption figure reads as low usage
    // rather than as missing recipe data.
    const consumption = code(QUERIES).slice(code(QUERIES).indexOf("function getTheoreticalConsumption"));
    expect(consumption).toMatch(/unmappedUnits/);
  });

  it("expands consumption over every dish, including retired ones", () => {
    // A sale from before a dish was archived still consumed its ingredients.
    const consumption = code(QUERIES).slice(code(QUERIES).indexOf("function getTheoreticalConsumption"));
    expect(consumption).toMatch(/status: "all"/);
  });
});

describe("database constraints", () => {
  it("restates the positive-quantity rule in the database", () => {
    expect(MIGRATION).toMatch(/CHECK \("quantity" > 0\)/);
  });

  it("restates the non-negative-price rule in the database", () => {
    expect(MIGRATION).toMatch(/CHECK \("unit_price_millis" >= 0\)/);
  });

  it("indexes the range scans the sales screens run", () => {
    expect(MIGRATION).toMatch(/"sales_org_location_sold_idx"[^;]*"organization_id", "location_id", "sold_at"/);
    expect(MIGRATION).toMatch(/"sales_org_sold_idx"[^;]*"organization_id", "sold_at"/);
  });

  it("stores timestamps with a timezone", () => {
    // A restaurant's day boundary is local; without an offset an evening sale
    // lands on the wrong day.
    expect(MIGRATION).toMatch(/"sold_at" timestamp with time zone/);
  });

  it("computes today's takings in the organization's timezone", () => {
    const today = queryFunctions.find(fn => fn.name === "getTodaySales")!;
    expect(code(today.body)).toMatch(/at time zone \$\{timeZone\}/);
  });
});

describe("row level security", () => {
  it("enables RLS on both sales tables", () => {
    expect(RLS).toMatch(/alter table public\.sales\s+enable row level security/);
    expect(RLS).toMatch(/alter table public\.sale_lines\s+enable row level security/);
  });

  it("restricts sale lines to members of the owning sale's organization", () => {
    const policy = RLS.slice(RLS.indexOf('create policy "members access sale lines"'));
    expect(policy.slice(0, policy.indexOf(";"))).toMatch(/is_org_member\(s\.organization_id\)/);
  });
});
