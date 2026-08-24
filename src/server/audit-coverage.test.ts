import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES, isAuditAction, isAuditEntityType } from "@/lib/audit-actions";

/**
 * Audit coverage.
 *
 * These tests read the source of every server action and assert that each one
 * records an audit entry. They exist because the failure they guard against is
 * silent: an action that forgets to audit works perfectly, ships, and is only
 * discovered when somebody needs to know who deleted a supplier and the answer
 * is nowhere.
 *
 * Structural assertions are unusual and worth justifying. Calling the actions
 * for real would need a Supabase session, a request context and a database,
 * none of which Vitest has here — so the choice is between checking the source
 * or checking nothing. Reading the source at least cannot drift from the source.
 *
 * The runtime behaviour these cannot prove — that a row actually lands, that a
 * rollback removes it — is covered by a database probe run against real data.
 */

const ACTIONS_DIR = path.join(process.cwd(), "src/server/actions");

/** Splits a module into its exported async functions, with their bodies. */
function exportedActions(source: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  const signature = /export\s+async\s+function\s+(\w+)\s*\(/g;

  let match: RegExpExecArray | null;
  while ((match = signature.exec(source)) !== null) {
    // Body runs to the next top-level export, or to end of file.
    const start = match.index;
    signature.lastIndex = match.index + match[0].length;
    const next = source.indexOf("\nexport ", start + 1);
    found.push({ name: match[1], body: source.slice(start, next === -1 ? source.length : next) });
  }
  return found;
}

function readActionModules() {
  return readdirSync(ACTIONS_DIR)
    .filter(file => file.endsWith(".ts"))
    .map(file => ({ file, source: readFileSync(path.join(ACTIONS_DIR, file), "utf8") }));
}

/**
 * Actions deliberately exempt from auditing, each with a reason.
 *
 * An exemption must be added here explicitly, so skipping the audit log is a
 * visible decision in a diff rather than an omission nobody notices.
 */
const EXEMPT: Record<string, string> = {
  // Draft autosave. This fires repeatedly while a counter types, so auditing it
  // would bury the log in keystrokes without adding accountability: the count is
  // editable only while in draft/counting, and the figures that actually matter
  // are recorded at `stock_count_submitted` (item count, variance count, net
  // value) and again at `stock_count_approved` (full per-line breakdown). After
  // submission a database trigger makes the sheet immutable.
  "stock-counts.ts:saveStockCountEntries": "Draft autosave; authoritative figures are audited at submit and approve.",

  // Read-only validation. `previewSalesImport` parses an uploaded file and
  // reports what an import *would* do; it opens no transaction and writes no
  // row, which `sales-import-integrity.test.ts` asserts directly. The run that
  // does write — `commitSalesImport` — audits inside its transaction. Logging
  // every preview would fill the trail with abandoned attempts while adding
  // nothing: nothing changed, so there is nothing to hold anyone to.
  "sales-import.ts:previewSalesImport": "Read-only preview; the commit that writes is audited transactionally.",

  // These operations happen before a Supabase Auth user has a workspace or
  // membership, so there is no organization audit trail to append to.
  "auth.ts:resolvePostAuthRoute": "Read-only routing decision; it writes no application state.",
  "auth.ts:registerWithAuthorization": "Pre-workspace Auth account creation is authorized by an employee or owner token.",
  "auth.ts:requestPasswordReset": "Supabase Auth recovery is unauthenticated and has no workspace audit context.",

  // Platform administration has no tenant context. These actions write to the
  // separate platform_audit_logs table instead of the tenant audit trail.
  "platform-admin.ts:issuePlatformOwnerInvitation": "Writes a platform audit event for owner onboarding issuance.",
  "platform-admin.ts:revokePlatformOwnerInvitation": "Writes a platform audit event for owner onboarding revocation.",
  "platform-admin.ts:updatePlatformOrganization": "Writes platform audit events for plan and status changes.",
};

describe("every server action records an audit entry", () => {
  const modules = readActionModules();

  it("finds the action modules", () => {
    expect(modules.length).toBeGreaterThanOrEqual(6);
  });

  for (const { file, source } of modules) {
    const actions = exportedActions(source);

    it(`${file} exposes actions`, () => {
      expect(actions.length).toBeGreaterThan(0);
    });

    for (const action of actions) {
      const exemptReason = EXEMPT[`${file}:${action.name}`];
      it(`${file} → ${action.name}${exemptReason ? " (exempt)" : ""}`, () => {
        if (exemptReason) {
          expect(exemptReason.length).toBeGreaterThan(0);
          return;
        }
        expect(action.body, `${action.name} in ${file} performs no recordAudit call`).toContain("recordAudit(");
      });
    }
  }
});

describe("audit coverage on write paths outside the action layer", () => {
  it("the waste endpoint audits, since it writes stock directly", () => {
    // /api/waste does not delegate to a guarded action — it inserts the waste
    // entry and the stock movement itself, so it must audit itself too.
    const source = readFileSync(path.join(process.cwd(), "src/app/api/waste/route.ts"), "utf8");
    expect(source).toContain("recordAudit(");
    expect(source).toContain("waste_recorded");
  });

  it("the purchases endpoint delegates to an audited action rather than writing its own rows", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/api/purchases/route.ts"), "utf8");
    expect(source).toContain("receivePurchase");
    expect(source).not.toContain("insert(");
  });
});

describe("security-critical audits are transactional", () => {
  // These actions must pass `tx` to recordAudit. Without it a failed audit
  // insert is swallowed, and the mutation stands with no record of who made it.
  const REQUIRED: Record<string, string[]> = {
    "team.ts": ["changeMemberRole", "removeMember", "revokeInvitation", "resendInvitation", "changeMemberLocation"],
    "ingredients.ts": ["saveIngredient", "setIngredientArchived", "deleteIngredient"],
    "suppliers.ts": ["saveSupplier", "setSupplierArchived", "deleteSupplier", "saveSupplierProduct", "deleteSupplierProduct"],
    "recipes.ts": ["setRecipeArchived", "deleteRecipe", "setMenuItemArchived", "deleteMenuItem"],
    "stock-counts.ts": ["createStockCount", "submitStockCount", "approveStockCount", "rejectStockCount"],
    "organization.ts": ["completeSetup", "reopenSetup", "updateOrganization", "saveLocation", "saveUnit", "deleteUnit"],
  };

  for (const [file, names] of Object.entries(REQUIRED)) {
    const source = readFileSync(path.join(ACTIONS_DIR, file), "utf8");
    const actions = exportedActions(source);

    for (const name of names) {
      it(`${file} → ${name} audits inside a transaction`, () => {
        const action = actions.find(entry => entry.name === name);
        expect(action, `${name} not found in ${file}`).toBeDefined();
        expect(action!.body).toContain("transaction(");
        // recordAudit must receive the transaction handle, not the pooled client.
        expect(action!.body, `${name} calls recordAudit without passing tx`).toMatch(/recordAudit\([\s\S]*?\btx\b[\s\S]*?\)/);
      });
    }
  }
});

describe("the audit vocabulary matches what the code actually writes", () => {
  const allSource = [
    ...readActionModules().map(entry => entry.source),
    readFileSync(path.join(process.cwd(), "src/app/api/waste/route.ts"), "utf8"),
  ].join("\n");

  it("every action string written by the code is a known vocabulary member", () => {
    const written = [...allSource.matchAll(/action:\s*(?:values\.id\s*\?\s*)?"([a-z_]+)"(?:\s*:\s*"([a-z_]+)")?/g)]
      .flatMap(match => [match[1], match[2]])
      .filter((value): value is string => Boolean(value));

    expect(written.length).toBeGreaterThan(10);
    const unknown = [...new Set(written)].filter(value => !isAuditAction(value));
    expect(unknown, `unknown audit actions: ${unknown.join(", ")}`).toEqual([]);
  });

  it("every entity type written by the code is a known vocabulary member", () => {
    const written = [...allSource.matchAll(/entityType:\s*"([a-z_]+)"/g)].map(match => match[1]);
    expect(written.length).toBeGreaterThan(10);
    const unknown = [...new Set(written)].filter(value => !isAuditEntityType(value));
    expect(unknown, `unknown entity types: ${unknown.join(", ")}`).toEqual([]);
  });

  it("the vocabulary contains no duplicates", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect(new Set(AUDIT_ENTITY_TYPES).size).toBe(AUDIT_ENTITY_TYPES.length);
  });

  it("every Part 13 event named in the spec is written somewhere", () => {
    for (const required of [
      "employee_invited",
      "member_role_changed",
      "member_removed",
      "stock_count_created",
      "stock_count_submitted",
      "stock_count_approved",
      "stock_count_rejected",
      "waste_recorded",
    ]) {
      expect(allSource, `no code writes the audit action "${required}"`).toContain(`"${required}"`);
    }
  });
});
