import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAuditAction, isAuditEntityType } from "@/lib/audit-actions";

/**
 * Structural guarantees for stock transfers.
 *
 * These read the source rather than calling it, for the reason set out in
 * `sales-integrity.test.ts`: the failures they guard against are silent. A
 * transfer that skips its location check moves another branch's stock. One that
 * writes outside a transaction leaves goods deducted from a source and never
 * added anywhere. One that drops its conditional UPDATE lets two people receive
 * the same van and doubles the destination's inventory. None of those crash, and
 * Vitest has no Supabase session or database with which to catch them at
 * runtime.
 *
 * The arithmetic — conversion, shortfalls, lifecycle rules — is exercised for
 * real in `lib/transfers.test.ts`, and the end-to-end ledger behaviour in
 * `scripts/verify-integrity.ts` against a live database.
 */

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const ACTIONS = read("src/server/actions/transfers.ts");
const QUERIES = read("src/server/queries/transfers.ts");
const DOMAIN = read("src/lib/transfers.ts");
const MIGRATION = read("drizzle/0008_stock_transfers.sql");
const RLS = read("supabase/rls.sql");
const SCHEMA = read("src/db/schema.ts");
const VALIDATION = read("src/lib/validation.ts");

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
const create = actions.find(fn => fn.name === "createTransfer")!;
const send = actions.find(fn => fn.name === "sendTransfer")!;
const receive = actions.find(fn => fn.name === "receiveTransfer")!;
const cancel = actions.find(fn => fn.name === "cancelTransfer")!;

/** Actions that change state and therefore must be transactional and audited. */
const MUTATIONS = [create, send, receive, cancel];

describe("the transfer modules parse", () => {
  it("exposes the four lifecycle actions", () => {
    expect(actions.map(fn => fn.name)).toEqual(
      expect.arrayContaining(["createTransfer", "sendTransfer", "receiveTransfer", "cancelTransfer"]),
    );
  });

  it("exposes the read queries", () => {
    expect(queries.map(fn => fn.name)).toEqual(
      expect.arrayContaining(["listTransfers", "getTransfer", "availableAtLocation"]),
    );
  });
});

describe("permission enforcement", () => {
  it("every mutation requires a permission", () => {
    for (const fn of MUTATIONS) {
      expect(code(fn.body), `${fn.name} must require a permission`).toMatch(/requirePermission\(tenant\.role, "/);
    }
  });

  it("creating, sending and receiving reuse record_operations", () => {
    // No new role or permission was introduced for transfers.
    for (const fn of [create, send, receive]) {
      expect(code(fn.body)).toMatch(/requirePermission\(tenant\.role, "record_operations"\)/);
    }
  });

  it("cancelling a dispatched transfer needs the stock-count permission", () => {
    // Reversing stock that has already left is a supervisory correction.
    expect(code(cancel.body)).toMatch(/requirePermission\(tenant\.role, "manage_stock_counts"\)/);
  });

  it("introduces no new permission of its own", () => {
    const permissions = read("src/lib/permissions.ts");
    expect(permissions).not.toMatch(/manage_transfers|approve_transfers|transfer_stock:/);
  });

  it("establishes the tenant before checking anything", () => {
    for (const fn of MUTATIONS) {
      const body = code(fn.body);
      expect(body.indexOf("requireTenant"), fn.name).toBeLessThan(body.indexOf("requirePermission"));
    }
  });

  it("checks the permission before parsing input", () => {
    for (const fn of MUTATIONS) {
      const body = code(fn.body);
      expect(body.indexOf("requirePermission"), fn.name).toBeLessThan(body.indexOf("Input.parse"));
    }
  });
});

describe("tenant isolation", () => {
  it("resolves ingredients scoped to the caller's organization", () => {
    // The cross-tenant boundary: an ingredient from another workspace is simply
    // not in the catalog, so it cannot be transferred.
    expect(code(create.body)).toMatch(/eq\(ingredients\.organizationId, tenant\.organizationId\)/);
  });

  it("stamps every transfer with the caller's own organization", () => {
    expect(code(create.body)).toMatch(/organizationId: tenant\.organizationId/);
  });

  it("never takes the organization from the request", () => {
    expect(code(ACTIONS)).not.toMatch(/values\.organizationId/);
  });

  it("scopes every state change by organization as well as id", () => {
    for (const fn of [send, receive, cancel]) {
      expect(code(fn.body), `${fn.name} must scope its UPDATE`).toMatch(
        /eq\(stockTransfers\.organizationId, tenant\.organizationId\)/,
      );
    }
  });

  it("scopes every read query by organization", () => {
    for (const fn of queries) {
      expect(code(fn.body), `${fn.name} must constrain the organization`).toMatch(/organizationId/);
    }
  });

  it("scopes a single transfer lookup in the WHERE clause, not after the fetch", () => {
    const getOne = queries.find(fn => fn.name === "getTransfer")!;
    expect(code(getOne.body)).toMatch(
      /eq\(stockTransfers\.id, transferId\),\s*eq\(stockTransfers\.organizationId, organizationId\)/,
    );
  });

  it("reads availability scoped to both organization and location", () => {
    // An organization-wide total would approve moving beef out of a site that
    // has none, because another site does.
    const available = queries.find(fn => fn.name === "availableAtLocation")!;
    expect(code(available.body)).toMatch(/eq\(stockMovements\.organizationId, organizationId\)/);
    expect(code(available.body)).toMatch(/eq\(stockMovements\.locationId, locationId\)/);
  });
});

describe("location authorization", () => {
  it("every mutation authorizes a location", () => {
    for (const fn of MUTATIONS) {
      expect(code(fn.body), `${fn.name} must authorize a location`).toMatch(/assertLocationAllowed\(/);
    }
  });

  it("pins a site-bound member to their own location", () => {
    const helper = ACTIONS.slice(ACTIONS.indexOf("async function authorizedLocationIds"));
    const body = code(helper.slice(0, helper.indexOf("\n}")));
    expect(body).toMatch(/canAccessAllLocations\(tenant\.role\)/);
    expect(body).toMatch(/option\.id === tenant\.locationId/);
  });

  it("authorizes sending against the source", () => {
    expect(code(send.body)).toMatch(/assertLocationAllowed\(allowed, detail\.sourceLocationId/);
  });

  it("authorizes receiving against the destination", () => {
    // The person unpacking the van signs for it — not the sender.
    expect(code(receive.body)).toMatch(/assertLocationAllowed\(allowed, detail\.destinationLocationId/);
  });

  it("verifies the destination belongs to the organization when creating", () => {
    expect(code(create.body)).toMatch(/organizationLocations\.includes\(values\.destinationLocationId\)/);
  });

  it("takes the locations from the stored transfer, not from the request", () => {
    // Taking them from the request would let a member name their own location
    // to act on somebody else's transfer.
    for (const fn of [send, receive, cancel]) {
      expect(code(fn.body), fn.name).toMatch(/detail\.(source|destination)LocationId/);
    }
  });
});

describe("the same-location rule", () => {
  it("is rejected by the validator", () => {
    expect(VALIDATION).toMatch(/sourceLocationId === values\.destinationLocationId/);
  });

  it("is rejected again in the action", () => {
    expect(code(create.body)).toMatch(/values\.sourceLocationId === values\.destinationLocationId/);
  });

  it("is rejected a third time by the database", () => {
    // Three layers, because the failure is silent: a transfer to itself posts a
    // matching − and + that net to zero.
    expect(MIGRATION).toMatch(/CHECK \("source_location_id" <> "destination_location_id"\)/);
  });
});

describe("insufficient stock", () => {
  it("is checked before sending", () => {
    for (const fn of [create, send]) {
      expect(code(fn.body), fn.name).toMatch(/findShortfalls\(/);
    }
  });

  it("reads availability inside the transaction that writes the movements", () => {
    // Outside it, another write could land between the check and the deduction.
    for (const fn of [create, send]) {
      const body = code(fn.body);
      const transaction = body.slice(body.indexOf("db.transaction"));
      expect(transaction, `${fn.name} must check availability inside the transaction`).toMatch(/availableAtLocation\(/);
    }
  });

  it("passes the transaction handle to the availability read", () => {
    for (const fn of [create, send]) {
      expect(code(fn.body), fn.name).toMatch(/availableAtLocation\([\s\S]{0,200}?\btx\b/);
    }
  });

  it("aborts the whole transfer rather than sending what it can", () => {
    // A partial send would leave the document disagreeing with the ledger.
    for (const fn of [create, send]) {
      expect(code(fn.body), fn.name).toMatch(/throw new ActionError\(`Not enough stock at the source/);
    }
  });

  it("does not check availability when only saving a draft", () => {
    // A draft moves nothing, so it may legitimately be written before the stock
    // has arrived.
    expect(code(create.body)).toMatch(/if \(values\.sendNow\)/);
  });
});

describe("ledger integration", () => {
  it("writes movements of the types the ledger already defines", () => {
    // `transfer_in` and `transfer_out` have existed in the enum since migration
    // 0000; this feature is their first writer.
    expect(code(ACTIONS)).toMatch(/"transfer_out"/);
    expect(code(ACTIONS)).toMatch(/"transfer_in"/);
    expect(SCHEMA).toMatch(/"transfer_in", "transfer_out"/);
  });

  it("deducts at the source and adds at the destination", () => {
    const helper = ACTIONS.slice(ACTIONS.indexOf("async function postTransferLeg"));
    const body = code(helper.slice(0, helper.indexOf("\n  return input.lines.length")));
    expect(body).toMatch(/direction === "out" \? "transfer_out" : "transfer_in"/);
    // The sign is what makes the balance move the right way.
    expect(body).toMatch(/direction === "out" \? String\(-Number\(line\.baseQuantity\)\)/);
  });

  it("records movements in the ingredient's base unit", () => {
    const helper = ACTIONS.slice(ACTIONS.indexOf("async function postTransferLeg"));
    expect(code(helper)).toMatch(/baseQuantity/);
  });

  it("ties every movement back to its transfer", () => {
    const helper = ACTIONS.slice(ACTIONS.indexOf("async function postTransferLeg"));
    expect(code(helper)).toMatch(/referenceType: "stock_transfer"/);
    expect(code(helper)).toMatch(/referenceId: input\.transferId/);
  });

  it("builds movement rows in exactly one place", () => {
    // A second insert into stockMovements would be a parallel ledger path.
    const inserts = code(ACTIONS).match(/insert\(stockMovements\)/g) ?? [];
    expect(inserts).toHaveLength(1);
  });

  it("computes no balance of its own", () => {
    // Inventory valuation and stock levels stay derived from the one ledger.
    expect(code(ACTIONS)).not.toMatch(/update\(\s*ingredients\s*\)/);
    expect(code(DOMAIN)).not.toMatch(/getDb\(|stockMovements/);
  });

  it("sends stock out only once per transfer", () => {
    // Sending twice would deduct twice; the status guard below prevents it.
    const posted = code(create.body).match(/postTransferLeg\(/g) ?? [];
    expect(posted.length).toBeLessThanOrEqual(1);
  });

  it("returns the stock to the source when a sent transfer is cancelled", () => {
    // The goods are on a van that turned back; they must land somewhere.
    expect(code(cancel.body)).toMatch(/direction: "in"/);
    expect(code(cancel.body)).toMatch(/locationId: detail\.sourceLocationId/);
  });

  it("writes nothing to the ledger when cancelling a draft", () => {
    expect(code(cancel.body)).toMatch(/if \(wasSent\)/);
  });
});

describe("concurrency and duplicate processing", () => {
  it("claims the row with a conditional UPDATE on the expected status", () => {
    // The guard that makes a double-click, a retry and two colleagues acting at
    // once resolve to one state change.
    expect(code(send.body)).toMatch(/eq\(stockTransfers\.status, "draft"\)/);
    expect(code(receive.body)).toMatch(/eq\(stockTransfers\.status, "sent"\)/);
    expect(code(cancel.body)).toMatch(/eq\(stockTransfers\.status, wasSent \? "sent" : "draft"\)/);
  });

  it("aborts when the claim matches no row", () => {
    for (const fn of [send, receive, cancel]) {
      expect(code(fn.body), `${fn.name} must abort when it loses the race`).toMatch(/if \(!claimed\) throw new ActionError/);
    }
  });

  it("claims the row before writing any movement", () => {
    // Posting first and claiming second would let the loser's movements land
    // before its transaction rolled back.
    for (const fn of [send, receive]) {
      const body = code(fn.body);
      expect(body.indexOf("claimed"), fn.name).toBeLessThan(body.indexOf("postTransferLeg("));
    }
  });

  it("rejects an already-received transfer before it reaches the database", () => {
    expect(code(receive.body)).toMatch(/status === "received"/);
  });

  it("refuses to receive anything that was not sent", () => {
    expect(code(receive.body)).toMatch(/detail\.status !== "sent"/);
  });

  it("refuses to send anything that is not a draft", () => {
    expect(code(send.body)).toMatch(/detail\.status !== "draft"/);
  });

  it("refuses to cancel a received transfer", () => {
    // The stock has landed; the correction is a transfer back, not a rewrite.
    expect(code(cancel.body)).toMatch(/status === "received"/);
  });
});

describe("atomicity", () => {
  it("wraps every mutation in a transaction", () => {
    for (const fn of MUTATIONS) {
      expect(code(fn.body), `${fn.name} must be transactional`).toMatch(/db\.transaction\(async tx =>/);
    }
  });

  it("performs no insert before the transaction opens", () => {
    for (const fn of MUTATIONS) {
      const body = code(fn.body);
      const before = body.slice(0, body.indexOf("db.transaction"));
      expect(before, `${fn.name} writes before its transaction`).not.toMatch(/\.insert\(|\.update\(/);
    }
  });

  it("uses the transaction handle for every write", () => {
    for (const fn of MUTATIONS) {
      const body = code(fn.body);
      const transaction = body.slice(body.indexOf("db.transaction"));
      for (const write of transaction.match(/\b(\w+)\.(insert|update)\(/g) ?? []) {
        expect(write, `${fn.name} used the pooled client inside its transaction`).toMatch(/^tx\./);
      }
    }
  });

  it("writes the document and its lines together", () => {
    const transaction = code(create.body).slice(code(create.body).indexOf("db.transaction"));
    expect(transaction).toMatch(/insert\(stockTransfers\)/);
    expect(transaction).toMatch(/insert\(stockTransferItems\)/);
  });
});

describe("audit logging", () => {
  it("every mutation records an audit entry", () => {
    for (const fn of MUTATIONS) {
      expect(code(fn.body), `${fn.name} performs no recordAudit call`).toMatch(/recordAudit\(/);
    }
  });

  it("records it inside the transaction", () => {
    // Outside it, a rolled-back transfer could leave a log claiming stock moved.
    for (const fn of MUTATIONS) {
      const body = code(fn.body);
      expect(body.indexOf("recordAudit"), fn.name).toBeGreaterThan(body.indexOf("db.transaction"));
      expect(body, `${fn.name} must pass tx to recordAudit`).toMatch(/recordAudit\([\s\S]*?\},\s*tx,\s*\)/);
    }
  });

  it("uses the transfer vocabulary", () => {
    for (const action of ["transfer_created", "transfer_sent", "transfer_received", "transfer_cancelled"]) {
      expect(code(ACTIONS), `no code writes "${action}"`).toContain(`"${action}"`);
      expect(isAuditAction(action)).toBe(true);
    }
    expect(code(ACTIONS)).toMatch(/entityType: "stock_transfer"/);
    expect(isAuditEntityType("stock_transfer")).toBe(true);
  });

  it("records both ends and the size of the movement", () => {
    for (const fn of MUTATIONS) {
      for (const field of ["sourceLocationId", "destinationLocationId"]) {
        expect(code(fn.body), `${fn.name} audit metadata should carry ${field}`).toMatch(new RegExp(`\\b${field}[:,]`));
      }
      expect(code(fn.body), `${fn.name} should record how many movements it wrote`).toMatch(/movementsCreated/);
    }
  });

  it("records why a transfer was cancelled", () => {
    expect(code(cancel.body)).toMatch(/reason: values\.reason/);
    expect(code(cancel.body)).toMatch(/wasSent/);
  });
});

describe("database constraints", () => {
  it("creates both tables", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "stock_transfers"/);
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS "stock_transfer_items"/);
  });

  it("restates the positive-quantity rule", () => {
    expect(MIGRATION).toMatch(/CHECK \("quantity" > 0\)/);
  });

  it("stores both the entered and the converted quantity", () => {
    expect(MIGRATION).toMatch(/"quantity" numeric\(18, 3\) NOT NULL/);
    expect(MIGRATION).toMatch(/"base_quantity" numeric\(18, 6\) NOT NULL/);
  });

  it("allows one line per ingredient", () => {
    expect(MIGRATION).toMatch(/CREATE UNIQUE INDEX[^;]*"stock_transfer_items_transfer_ingredient_uidx"/);
  });

  it("keeps transfer history when a location is deleted", () => {
    const constraints = MIGRATION.match(/"stock_transfers_(source|destination)_location_id_locations_id_fk"[\s\S]{0,200}?ON DELETE (\w+)/g) ?? [];
    expect(constraints).toHaveLength(2);
    for (const constraint of constraints) expect(constraint).toMatch(/ON DELETE restrict/);
  });

  it("keeps transfer history when an ingredient is deleted", () => {
    expect(MIGRATION).toMatch(/"stock_transfer_items_ingredient_id_ingredients_id_fk"[\s\S]{0,200}?ON DELETE restrict/);
  });

  it("removes the lines with their transfer", () => {
    expect(MIGRATION).toMatch(/"stock_transfer_items_transfer_id_stock_transfers_id_fk"[\s\S]{0,200}?ON DELETE cascade/);
  });

  it("indexes both directions the list screen filters on", () => {
    expect(MIGRATION).toMatch(/"stock_transfers_source_idx"[^;]*"organization_id", "source_location_id", "status"/);
    expect(MIGRATION).toMatch(/"stock_transfers_destination_idx"[^;]*"organization_id", "destination_location_id", "status"/);
  });

  it("stores timestamps with a timezone", () => {
    expect(MIGRATION).toMatch(/"sent_at" timestamp with time zone/);
    expect(MIGRATION).toMatch(/"received_at" timestamp with time zone/);
  });

  it("is re-runnable like every other migration here", () => {
    expect(MIGRATION).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(MIGRATION).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
  });

  it("is registered in the migration journal", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json")) as { entries: { tag: string }[] };
    expect(journal.entries.map(entry => entry.tag)).toContain("0008_stock_transfers");
  });

  it("declares both tables in the Drizzle schema", () => {
    expect(SCHEMA).toMatch(/export const stockTransfers = pgTable\("stock_transfers"/);
    expect(SCHEMA).toMatch(/export const stockTransferItems = pgTable\("stock_transfer_items"/);
  });
});

describe("row level security", () => {
  it("enables RLS on both tables", () => {
    expect(RLS).toMatch(/alter table public\.stock_transfers\s+enable row level security/);
    expect(RLS).toMatch(/alter table public\.stock_transfer_items\s+enable row level security/);
  });

  it("covers the parent with the organization-scoped policy loop", () => {
    const loop = RLS.slice(RLS.indexOf("foreach target in array"), RLS.indexOf("end loop"));
    expect(loop).toMatch(/'stock_transfers'/);
  });

  it("reaches the lines' tenant through the transfer that owns them", () => {
    const policy = RLS.slice(RLS.indexOf('create policy "members access stock transfer items"'));
    expect(policy.slice(0, policy.indexOf(";"))).toMatch(/is_org_member\(t\.organization_id\)/);
  });
});
