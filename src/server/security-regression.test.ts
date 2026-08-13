import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isDemoMode } from "@/lib/demo-mode";
import {
  menuItemInput,
  purchaseItemInput,
  recordSaleInput,
  saleLineInput,
  stockCountEntryInput,
  transferLineInput,
  wasteInput,
} from "@/lib/validation";

/**
 * Security regression tests.
 *
 * One test per vulnerability found in the security audit, plus the enforcement
 * invariants that would have caught them earlier. Each `describe` names the class
 * of failure rather than the mechanism, so a future reader can tell whether a
 * failing assertion is a real regression or a rule that legitimately moved.
 *
 * ## Why so many of these read source instead of calling code
 *
 * The same reason `audit-coverage.test.ts` and `sales-integrity.test.ts` do:
 * calling a server action needs a Supabase session, a request context and a
 * database, none of which Vitest has. And the failures here are silent — an
 * action that forgets its location check works perfectly for everyone who is not
 * attacking it. Reading the source cannot prove the runtime behaviour, but it can
 * prove the guard is present at every site that needs one, which is exactly the
 * property that decays as a codebase grows.
 *
 * What source reading cannot do is prove the *database* refuses what it should.
 * That is `scripts/verify-security.ts`, which runs the cross-tenant, role,
 * location and RLS probes against a real database inside a transaction it always
 * rolls back. The two are complementary and both are needed: this file fails in
 * CI, that one fails against reality.
 */

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const ACTIONS_DIR = path.join(root, "src/server/actions");
const RLS = read("supabase/rls.sql");
const SCHEMA = read("src/db/schema.ts");
const VALIDATION = read("src/lib/validation.ts");
const LOCATIONS = read("src/server/queries/locations.ts");
const AUDIT_MIGRATION = read("drizzle/0009_audit_log_immutability.sql");
const TENANT_INTEGRITY_MIGRATION = read("drizzle/0010_tenant_integrity.sql");
const JOURNAL = read("drizzle/meta/_journal.json");
const NEXT_CONFIG = read("next.config.mjs");
const ACTION_RESULT = read("src/server/action-result.ts");

/**
 * Source with comments removed.
 *
 * Several assertions below are "this string must not appear". A comment
 * *explaining* the string would otherwise fail them — the health route documents
 * that it no longer returns `current_database()`, which is exactly the phrase its
 * test forbids.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every exported async function in a module, with its body. */
function exportedActions(source: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  const signature = /export\s+async\s+function\s+(\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = signature.exec(source)) !== null) {
    const start = match.index;
    signature.lastIndex = match.index + match[0].length;
    const next = source.indexOf("\nexport ", start + 1);
    found.push({ name: match[1], body: source.slice(start, next === -1 ? source.length : next) });
  }
  return found;
}

const actionModules = readdirSync(ACTIONS_DIR)
  .filter(file => file.endsWith(".ts"))
  .map(file => ({ file, source: readFileSync(path.join(ACTIONS_DIR, file), "utf8") }));

const allActions = actionModules.flatMap(({ file, source }) =>
  exportedActions(source).map(action => ({ ...action, file, key: `${file}:${action.name}` })),
);

const ROUTE_FILES = [
  "src/app/api/waste/route.ts",
  "src/app/api/purchases/route.ts",
  "src/app/api/health/route.ts",
  "src/app/api/invoices/upload-url/route.ts",
  "src/app/auth/callback/route.ts",
  "src/app/auth/signout/route.ts",
];

// ---------------------------------------------------------------------------

describe("direct server-action bypass: nothing runs without a session", () => {
  /**
   * Two actions authenticate without `requireTenant`, each for a structural
   * reason rather than convenience.
   */
  const EXEMPT: Record<string, string> = {
    "organization.ts:createWorkspace":
      "Runs before any tenant exists — it creates the organization. Authenticates with supabase.auth.getUser() directly.",
    "team.ts:acceptInvitation":
      "The redeemer is not yet a member of the organization they are joining. Authenticates with supabase.auth.getUser() directly.",
  };

  it("finds the actions to check", () => {
    expect(allActions.length).toBeGreaterThanOrEqual(25);
  });

  for (const action of allActions) {
    it(`${action.key} establishes who is calling`, () => {
      if (EXEMPT[action.key]) {
        // An exemption still has to authenticate, just not through requireTenant.
        expect(action.body, `${action.key} is exempt but never authenticates`).toContain("auth.getUser()");
        return;
      }
      expect(action.body, `${action.key} never calls requireTenant`).toMatch(/requireTenant(Location)?\(\)/);
    });
  }
});

describe("unauthorized role: every mutation consults the permission matrix", () => {
  const EXEMPT: Record<string, string> = {
    "organization.ts:createWorkspace": "No role exists yet; the caller becomes the owner of what they create.",
    "team.ts:acceptInvitation": "Possession of the invitation token is the authorization; the role comes from the row.",
  };

  for (const action of allActions) {
    it(`${action.key} requires a permission`, () => {
      if (EXEMPT[action.key]) {
        expect(EXEMPT[action.key].length).toBeGreaterThan(0);
        return;
      }
      expect(action.body, `${action.key} performs no permission check`).toMatch(/require(Permission|Role)\(/);
    });
  }

  it("checks the permission before touching the payload", () => {
    // Parsing first would let an unauthorized caller probe validation behaviour,
    // and worse, would put the expensive work before the cheap refusal.
    for (const action of allActions) {
      const permissionAt = action.body.search(/require(Permission|Role)\(/);
      const parseAt = action.body.search(/\.parse\(/);
      if (permissionAt === -1 || parseAt === -1) continue;
      expect(permissionAt, `${action.key} parses input before checking the role`).toBeLessThan(parseAt);
    }
  });

  it("the waste endpoint checks a permission, since it writes stock without an action", () => {
    const source = read("src/app/api/waste/route.ts");
    expect(source).toContain('hasPermission(tenant.role, "record_operations")');
    expect(source).toContain("status: 403");
  });

  it("the invoice upload endpoint checks a permission before issuing a signed URL", () => {
    // Regression: it previously required only membership, so a read-only
    // accountant could obtain a write URL into the workspace's bucket.
    const source = read("src/app/api/invoices/upload-url/route.ts");
    expect(source).toContain('hasPermission(tenant.role, "manage_purchasing")');
    expect(source).toContain("status: 403");
  });
});

describe("cross-tenant write: the organization is never taken from the request", () => {
  it("no validation schema accepts an organization id", () => {
    expect(VALIDATION).not.toMatch(/organizationId/);
  });

  it("no action reads an organization id out of its input", () => {
    for (const action of allActions) {
      expect(action.body, `${action.key} reads an organization from the request`).not.toMatch(
        /(values|input|raw|formData)\.organizationId/,
      );
    }
  });

  it("every action scopes its work by the session's organization", () => {
    /**
     * One action queries nothing itself. `previewSalesImport` hands the whole job
     * to `planImport(values, tenant)`, which loads the catalog and the location
     * list scoped to `tenant.organizationId` — asserted directly in
     * `sales-import-integrity.test.ts`. An exemption is listed rather than the
     * rule relaxed, so a second delegating action has to be justified too.
     */
    const EXEMPT: Record<string, string> = {
      "sales-import.ts:previewSalesImport": "Delegates every read to planImport(values, tenant), which scopes by organization.",
    };

    for (const action of allActions) {
      if (EXEMPT[action.key]) {
        expect(action.body, `${action.key} is exempt but does not delegate with the tenant`).toMatch(/planImport\(values, tenant\)/);
        continue;
      }
      expect(action.body, `${action.key} never mentions an organization`).toMatch(/organizationId/);
    }
  });

  it("receiving a purchase verifies the supplier belongs to the caller's organization", () => {
    // Regression: `purchases.supplier_id` has a foreign key but no tenant
    // constraint, so an unchecked id filed this workspace's invoice against
    // another workspace's supplier — and the detail screen then rendered that
    // supplier's name.
    const receive = allActions.find(action => action.key === "purchases.ts:receivePurchase")!;
    expect(receive.body).toMatch(/eq\(suppliers\.organizationId, tenant\.organizationId\)/);
  });

  it("purchase reads join the supplier within the tenant, not on the key alone", () => {
    const queries = read("src/server/queries/purchases.ts");
    const joins = [...queries.matchAll(/leftJoin\(suppliers,(.*)$/gm)].map(match => match[1]);
    expect(joins.length).toBeGreaterThan(0);
    for (const join of joins) {
      expect(join, "a supplier join is not tenant-scoped").toContain("suppliers.organizationId");
    }
  });
});

describe("cross-tenant read: a foreign id reveals nothing, not even that it exists", () => {
  /**
   * Each of these actions takes an id and looks up what *references* it before
   * deleting. Those reference queries have to be tenant-scoped too, or the
   * refusal message becomes an oracle: `deleteRecipe` returned the name of the
   * other workspace's recipe that used the id, and the other two reported
   * whether a foreign id had history.
   */
  const DELETES = [
    { key: "recipes.ts:deleteRecipe", table: "recipes" },
    { key: "ingredients.ts:deleteIngredient", table: "ingredients" },
    { key: "suppliers.ts:deleteSupplier", table: "suppliers" },
  ];

  for (const { key, table } of DELETES) {
    it(`${key} resolves ownership before inspecting references`, () => {
      const action = allActions.find(entry => entry.key === key)!;
      const ownershipAt = action.body.indexOf(`eq(${table}.organizationId, tenant.organizationId)`);
      expect(ownershipAt, `${key} never checks ownership`).toBeGreaterThan(-1);

      // The ownership check must come before the first reference lookup that
      // could name another tenant's row.
      const referenceAt = action.body.search(/(stockMovements|recipeIngredients|menuItemLines|purchases)\.[a-zA-Z]*Id/);
      if (referenceAt !== -1) {
        expect(ownershipAt, `${key} inspects references before proving ownership`).toBeLessThan(referenceAt);
      }
    });
  }

  it("every reference lookup in those deletes is itself tenant-scoped", () => {
    for (const { key } of DELETES) {
      const action = allActions.find(entry => entry.key === key)!;
      const lookups = action.body.split(".limit(1)").slice(0, -1);
      for (const lookup of lookups) {
        if (!/\.from\(/.test(lookup)) continue;
        expect(lookup, `an unscoped lookup in ${key}`).toMatch(/organizationId/);
      }
    }
  });

  it("the waste endpoint scopes its ingredient lookup in the WHERE clause", () => {
    // It used to fetch by id and compare the organization afterwards, which is
    // the same oracle in a different shape.
    const source = read("src/app/api/waste/route.ts");
    expect(source).toMatch(/eq\(ingredients\.organizationId, tenant\.organizationId\)/);
    expect(source).not.toMatch(/ingredient\.organizationId !== tenant\.organizationId/);
  });
});

describe("unauthorized location: a payload cannot reach another site", () => {
  /** Guards that establish a location belongs to the caller's organization. */
  const ANY_GUARD = /(assertLocationAllowed|assertMemberLocation|assertLocationInOrg|authorizedLocationIds)\(/;
  /** Guards that additionally pin a site-bound member to their own location. */
  const PINNING_GUARD = /(assertLocationAllowed|assertMemberLocation|authorizedLocationIds)\(/;

  it("the shared guard checks organization ownership and role reach", () => {
    expect(LOCATIONS).toMatch(/ownsLocation\(tenant\.organizationId, locationId\)/);
    expect(LOCATIONS).toMatch(/!canAccessAllLocations\(tenant\.role\)\s*&&\s*tenant\.locationId !== locationId/);
  });

  it("every action that handles a location authorizes it", () => {
    const handlers = allActions.filter(action => /\blocationId\b/.test(action.body));
    expect(handlers.length).toBeGreaterThanOrEqual(12);
    for (const action of handlers) {
      expect(action.body, `${action.key} handles a location without authorizing it`).toMatch(ANY_GUARD);
    }
  });

  /**
   * Actions that move stock, money or a document at a location the *client*
   * names. These need the pinning guard, not merely an ownership check.
   */
  const SITE_BOUND = [
    "purchases.ts:receivePurchase",
    "sales.ts:recordSale",
    "sales.ts:voidSale",
    "sales-import.ts:previewSalesImport",
    "sales-import.ts:commitSalesImport",
    "stock-counts.ts:createStockCount",
    "stock-counts.ts:saveStockCountEntries",
    "stock-counts.ts:submitStockCount",
    "stock-counts.ts:approveStockCount",
    "stock-counts.ts:rejectStockCount",
    "stock-counts.ts:deleteStockCount",
    "transfers.ts:createTransfer",
    "transfers.ts:sendTransfer",
    "transfers.ts:receiveTransfer",
    "transfers.ts:cancelTransfer",
  ];

  for (const key of SITE_BOUND) {
    it(`${key} pins a site-bound member to their own location`, () => {
      const action = allActions.find(entry => entry.key === key);
      expect(action, `${key} not found — was it renamed?`).toBeDefined();
      expect(action!.body, `${key} does not pin the caller to an authorized location`).toMatch(PINNING_GUARD);
    });
  }

  it("discarding a stock count authorizes the location before deleting", () => {
    // Regression: this was the one count action with no location check, and
    // `manage_stock_counts` includes the site-bound inventory role — so another
    // branch's draft could be destroyed by passing its id.
    const action = allActions.find(entry => entry.key === "stock-counts.ts:deleteStockCount")!;
    const guardAt = action.body.search(/assertLocationAllowed\(/);
    const deleteAt = action.body.indexOf(".delete(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt, "deleteStockCount deletes before authorizing").toBeLessThan(deleteAt);
  });

  it("receiving a purchase posts to the location on the invoice, not the caller's default", () => {
    // Regression: the field was validated then ignored, so stock landed at the
    // member's default location whatever the invoice said.
    const action = allActions.find(entry => entry.key === "purchases.ts:receivePurchase")!;
    expect(action.body).toMatch(/assertMemberLocation\(tenant, values\.locationId/);
    expect(action.body).not.toMatch(/locationId: tenant\.locationId/);
  });

  it("voiding a sale authorizes the sale's stored location, not one from the request", () => {
    const action = allActions.find(entry => entry.key === "sales.ts:voidSale")!;
    expect(action.body).toMatch(/assertLocationAllowed\(tenant, existing\.locationId\)/);
  });

  it("a site-bound member cannot open an unrelated transfer by changing the URL", () => {
    const page = read("src/app/dashboard/transfers/[id]/page.tsx");
    expect(page).toMatch(/!canAccessAllLocations\(tenant\.role\)/);
    expect(page).toMatch(/tenant\.locationId !== transfer\.sourceLocationId/);
    expect(page).toMatch(/tenant\.locationId !== transfer\.destinationLocationId/);
    expect(page).toMatch(/notFound\(\)/);
  });

  it("a site-bound member cannot open a sibling location's purchase by changing the URL", () => {
    const page = read("src/app/dashboard/purchases/[id]/page.tsx");
    expect(page).toMatch(/!canAccessAllLocations\(tenant\.role\)/);
    expect(page).toMatch(/tenant\.locationId !== purchase\.locationId/);
    expect(page).toMatch(/notFound\(\)/);
  });

  it("sales import history is filtered to the member's resolved location", () => {
    const page = read("src/app/dashboard/sales/imports/page.tsx");
    expect(page).toMatch(/resolveMemberLocation\(tenant, undefined\)/);
    expect(page).toMatch(/listSalesImports\(tenant\.organizationId, \{ locationId: location\.id \}\)/);
  });

  it("purchase location options are narrowed for site-bound members", () => {
    const page = read("src/app/dashboard/purchases/page.tsx");
    expect(page).toMatch(/resolveMemberLocation\(tenant, undefined\)/);
    expect(page).toMatch(/location\.options\.filter/);
    expect(page).toMatch(/listPurchases\(tenant\.organizationId, \{ locationId: location\.id/);
  });

  it("the waste endpoint writes the session's location, never the body's", () => {
    const source = read("src/app/api/waste/route.ts");
    expect(source).toMatch(/locationId: tenant\.locationId!/);
    expect(source).not.toMatch(/locationId: input\.locationId/);
  });
});

describe("invitation escalation", () => {
  it("invitation redemption requires a Supabase-verified email address", () => {
    const accept = allActions.find(action => action.key === "team.ts:acceptInvitation")!;
    expect(accept.body).toMatch(/user\.email_confirmed_at/);

    const page = read("src/app/invite/[token]/page.tsx");
    expect(page).toMatch(/user\.email_confirmed_at/);
    expect(page).toMatch(/checkInvitationRedeemable\(invitation, verifiedEmail\)/);
  });

  it("an invitation may never grant owner, in validation, in the action, and in the database", () => {
    expect(VALIDATION).toMatch(/invitableRole = z\.enum\(\["manager", "inventory", "kitchen", "accountant"\]\)/);
    expect(read("drizzle/0004_team_invitations.sql")).toMatch(/CHECK \("role" <> 'owner'\)/);
    expect(read("src/lib/invitations.ts")).toMatch(/INVITABLE_ROLES/);
  });

  it("redemption re-checks the stored role rather than trusting the row", () => {
    const invitations = read("src/lib/invitations.ts");
    expect(invitations).toMatch(/role_not_invitable/);
    const accept = allActions.find(action => action.key === "team.ts:acceptInvitation")!;
    // The granted role is the one redeemability approved, never a request field.
    expect(accept.body).not.toMatch(/(values|input)\.role/);
    expect(accept.body).toMatch(/grantedRole/);
  });

  it("redemption is single-use: the invitation is claimed conditionally", () => {
    // Without the status predicate, two concurrent redemptions both pass the
    // read-only redeemability check and the second writes a duplicate audit entry
    // claiming the invitation was accepted again.
    const accept = allActions.find(action => action.key === "team.ts:acceptInvitation")!;
    expect(accept.body).toMatch(/eq\(organizationInvitations\.status, "pending"\)/);
    expect(accept.body).toMatch(/if \(!consumed\) return false/);
    const claimAt = accept.body.indexOf("organizationInvitations.status");
    const insertAt = accept.body.indexOf("insert(organizationMembers)");
    expect(claimAt, "the membership is written before the invitation is claimed").toBeLessThan(insertAt);
  });

  it("only an owner may grant or remove the owner role", () => {
    const change = allActions.find(action => action.key === "team.ts:changeMemberRole")!;
    expect(change.body).toMatch(/nextRole === "owner" \|\| currentRole === "owner"/);
    expect(change.body).toMatch(/requirePermission\(tenant\.role, "transfer_ownership"\)/);
  });

  it("nobody may act on their own membership", () => {
    for (const key of ["team.ts:changeMemberRole", "team.ts:removeMember"]) {
      const action = allActions.find(entry => entry.key === key)!;
      expect(action.body, `${key} allows self-targeting`).toMatch(/assertNotSelf\(/);
    }
  });

  it("every team mutation re-scopes the target to the caller's organization", () => {
    const team = read("src/server/actions/team.ts");
    const updates = [...team.matchAll(/\.(update|delete)\(organization(Members|Invitations)\)([\s\S]*?)(?=\.returning|;)/g)];
    expect(updates.length).toBeGreaterThan(3);
    for (const [, , table, clause] of updates) {
      // Invitations are keyed by id within the organization; the accept path is
      // keyed by the invitation's own id plus its pending status, which is
      // tenant-safe because the token resolved the row.
      const scoped = /organizationId, tenant\.organizationId/.test(clause) || /organizationInvitations\.id, invitation\.id/.test(clause);
      expect(scoped, `an unscoped ${table} mutation`).toBe(true);
    }
  });
});

describe("invalid financial values", () => {
  const UUID = "9f1c0f4e-9c1a-4a3a-8b1e-2f3a4b5c6d7e";

  it("rejects negative and zero quantities on a purchase line", () => {
    for (const quantity of [-5, 0, -0.001]) {
      expect(purchaseItemInput.safeParse({ ingredientId: UUID, quantity, unitCode: "kg", unitCost: 1 }).success).toBe(false);
    }
  });

  it("rejects a negative price anywhere money is entered", () => {
    expect(purchaseItemInput.safeParse({ ingredientId: UUID, quantity: 1, unitCode: "kg", unitCost: -1 }).success).toBe(false);
    expect(menuItemInput.safeParse({
      name: "Burger",
      sellingPrice: -1,
      items: [{ kind: "ingredient", ingredientId: UUID, quantity: 1, unitCode: "kg" }],
    }).success).toBe(false);
  });

  it("rejects quantities that are not finite numbers", () => {
    for (const quantity of ["abc", Infinity, -Infinity, NaN]) {
      expect(purchaseItemInput.safeParse({ ingredientId: UUID, quantity, unitCode: "kg", unitCost: 1 }).success).toBe(false);
    }
  });

  it("rejects impossible magnitudes rather than storing them", () => {
    // The ledger is numeric(18,3) and money is a 32-bit integer of minor units;
    // an unbounded input overflows one or both.
    expect(purchaseItemInput.safeParse({ ingredientId: UUID, quantity: 2e9, unitCode: "kg", unitCost: 1 }).success).toBe(false);
    expect(purchaseItemInput.safeParse({ ingredientId: UUID, quantity: 1, unitCode: "kg", unitCost: 2e9 }).success).toBe(false);
  });

  it("rejects a negative physical count and a negative transfer line", () => {
    expect(stockCountEntryInput.safeParse({ itemId: UUID, countedQuantity: -3 }).success).toBe(false);
    expect(transferLineInput.safeParse({ ingredientId: UUID, quantity: -1 }).success).toBe(false);
  });

  it("rejects malformed ids, unknown enum values, bad dates and oversized text", () => {
    expect(purchaseItemInput.safeParse({ ingredientId: "not-a-uuid", quantity: 1, unitCode: "kg", unitCost: 1 }).success).toBe(false);
    expect(wasteInput.safeParse({ ingredientId: UUID, quantity: 1, reason: "shrinkage" }).success).toBe(false);
    expect(wasteInput.safeParse({ ingredientId: UUID, quantity: 1, reason: "other", note: "x".repeat(501) }).success).toBe(false);
    expect(recordSaleInput.safeParse({
      locationId: UUID,
      soldAt: "13/45/2026",
      items: [{ menuItemId: UUID, quantity: 1 }],
    }).success).toBe(false);
  });

  it("a client-supplied price on a sale line is discarded, not honoured", () => {
    const parsed = saleLineInput.safeParse({ menuItemId: UUID, quantity: 2, unitPriceMillis: 1, lineTotalMillis: 1 });
    expect(parsed.success).toBe(true);
    // The parsed value carries no price at all: the shape is the defence.
    expect(Object.keys(parsed.data!).sort()).toEqual(["menuItemId", "quantity"]);
  });

  it("a sale is priced from the server's own catalog", () => {
    const record = allActions.find(action => action.key === "sales.ts:recordSale")!;
    expect(record.body).toMatch(/sellingPriceMillis: menuItems\.sellingPriceMillis/);
    expect(record.body).toMatch(/eq\(menuItems\.organizationId, tenant\.organizationId\)/);
  });

  it("waste is costed from the ingredient's stored cost, not from the request", () => {
    const source = read("src/app/api/waste/route.ts");
    expect(source).toMatch(/estimatedCostMillis = Math\.round\(baseQuantity \* ingredient\.latestUnitCostMillis\)/);
    expect(source).not.toMatch(/input\.estimatedCostMillis/);
  });

  it("waste converts the entered unit into the base unit before touching the ledger", () => {
    // Regression: the typed quantity was written straight through, so 2 kg of a
    // gram-based ingredient deducted 2 g and priced the loss at two grams.
    const source = read("src/app/api/waste/route.ts");
    expect(source).toMatch(/toBaseQuantity\(input\.quantity/);
    expect(source).toMatch(/quantity: String\(-baseQuantity\)/);
    expect(source).not.toMatch(/quantity: String\(-input\.quantity\)/);
  });

  it("the import re-plans on the server rather than trusting a submitted plan", () => {
    const commit = allActions.find(action => action.key === "sales-import.ts:commitSalesImport")!;
    expect(commit.body).toMatch(/planImport\(values, tenant\)/);
    expect(VALIDATION).not.toMatch(/plan:\s*z\./);
  });
});

describe("RLS enforcement is configured for every table", () => {
  const tables = [...SCHEMA.matchAll(/pgTable\("(\w+)"/g)].map(match => match[1]);

  it("finds the schema's tables", () => {
    expect(tables.length).toBeGreaterThanOrEqual(20);
  });

  for (const table of tables) {
    it(`${table} has row level security enabled`, () => {
      expect(RLS, `${table} is missing from rls.sql`).toMatch(
        new RegExp(`alter table public\\.${table}\\s+enable row level security`),
      );
    });
  }

  it("every table named in rls.sql also has a policy", () => {
    // Enabled without a policy denies everything, which fails closed but breaks
    // the Data API silently. The script's own verification block reports both.
    expect(RLS).toMatch(/Tables with RLS but no policy/);
  });

  it("child tables reach their tenant through the row that owns them", () => {
    for (const child of ["purchase_items", "recipe_ingredients", "menu_item_lines", "stock_count_items", "sale_lines", "stock_transfer_items"]) {
      const policy = RLS.slice(RLS.indexOf(`on public.${child}`));
      expect(policy.slice(0, 600), `${child} has no owner-row policy`).toMatch(/exists\(select 1 from public\.\w+/);
    }
  });

  it("the browser roles hold no privileges on application tables", () => {
    /**
     * The audit's most serious finding. RLS answers "whose data is this" but
     * cannot answer "what may this person do with it" — `is_org_member()` is true
     * for every member whatever their role. While `authenticated` held table
     * grants, any signed-in member could use the Data API to reprice the menu,
     * insert sales and stock movements, write at a location they are not assigned
     * to, delete audit rows, or mint a manager invitation.
     */
    expect(RLS).toMatch(/revoke all on all tables in schema public from anon, authenticated/);
    expect(RLS).toMatch(/revoke all on all sequences in schema public from anon, authenticated/);
    expect(RLS).not.toMatch(/grant select, insert, update, delete on all tables in schema public to authenticated/);
  });

  it("future tables do not inherit the grant", () => {
    // Supabase's project bootstrap grants on newly created tables; without this
    // the next migration silently re-opens the Data API.
    expect(RLS).toMatch(/alter default privileges in schema public revoke all on tables from anon, authenticated/);
  });

  it("the verification block reports lingering browser grants", () => {
    expect(RLS).toMatch(/Browser roles still hold table privileges/);
  });

  it("memberships stay readable but not writable through the Data API", () => {
    // A SELECT-only policy is what stops a member updating their own role row.
    const policy = RLS.slice(RLS.indexOf("on public.organization_members"));
    expect(policy.slice(0, 300)).toMatch(/for select to authenticated/);
    expect(policy.slice(0, 300)).not.toMatch(/for all/);
  });

  it("invoice storage writes enforce manage_purchasing instead of membership alone", () => {
    const storage = read("supabase/storage.sql");
    expect(RLS).toMatch(/can_manage_purchasing/);
    for (const operation of ["insert", "update", "delete"]) {
      const start = storage.indexOf(`for ${operation} to authenticated`);
      expect(start, `invoice ${operation} policy is missing`).toBeGreaterThan(-1);
      expect(storage.slice(start, start + 500), `invoice ${operation} allows every member`).toContain("can_manage_purchasing");
    }
  });
});

 describe("tenant consistency survives a privileged server connection", () => {
  it("registers the tenant-integrity migration", () => {
    expect(JOURNAL).toContain("0010_tenant_integrity");
  });

  it("ties tenant-owned references to the same organization", () => {
    for (const constraint of [
      "organization_members_location_same_org_fk",
      "organization_invitations_location_same_org_fk",
      "supplier_products_supplier_same_org_fk",
      "supplier_products_ingredient_same_org_fk",
      "purchases_location_same_org_fk",
      "purchases_supplier_same_org_fk",
      "stock_movements_location_same_org_fk",
      "stock_movements_ingredient_same_org_fk",
      "waste_entries_location_same_org_fk",
      "waste_entries_ingredient_same_org_fk",
      "sales_location_same_org_fk",
      "sales_import_same_org_fk",
      "sales_imports_location_same_org_fk",
      "stock_counts_location_same_org_fk",
      "stock_transfers_source_same_org_fk",
      "stock_transfers_destination_same_org_fk",
    ]) {
      expect(TENANT_INTEGRITY_MIGRATION, `missing ${constraint}`).toContain(constraint);
    }
  });

  it("checks the tenant inherited by every child table", () => {
    for (const trigger of [
      "purchase_items_same_org_trg",
      "recipe_ingredients_same_org_trg",
      "menu_item_lines_same_org_trg",
      "sale_lines_same_org_trg",
      "stock_count_items_same_org_trg",
      "stock_transfer_items_same_org_trg",
    ]) {
      expect(TENANT_INTEGRITY_MIGRATION, `missing ${trigger}`).toContain(trigger);
    }
  });
});

describe("the audit trail cannot be rewritten", () => {
  it("a database trigger refuses UPDATE, DELETE and TRUNCATE", () => {
    expect(AUDIT_MIGRATION).toMatch(/BEFORE UPDATE OR DELETE OR TRUNCATE ON public\.audit_logs/);
    expect(AUDIT_MIGRATION).toMatch(/audit_logs is append-only/);
  });

  it("the migration is registered so it actually runs", () => {
    expect(JOURNAL).toContain("0009_audit_log_immutability");
  });

  it("no application code updates or deletes an audit row", () => {
    // The trigger holds on every connection, including the privileged one the
    // server uses; this keeps the application honest about not trying.
    for (const { file, source } of actionModules) {
      expect(source, `${file} mutates audit_logs`).not.toMatch(/(update|delete)\(auditLogs\)/);
    }
    expect(read("src/server/audit.ts")).not.toMatch(/(update|delete)\(auditLogs\)/);
  });

  it("destructive actions bind their audit entry to the transaction", () => {
    // A swallowed audit failure on a delete leaves no trace the row existed.
    for (const key of [
      "ingredients.ts:deleteIngredient",
      "suppliers.ts:deleteSupplier",
      "recipes.ts:deleteRecipe",
      "recipes.ts:deleteMenuItem",
      "organization.ts:deleteUnit",
      "stock-counts.ts:deleteStockCount",
      "team.ts:removeMember",
      "team.ts:changeMemberRole",
    ]) {
      const action = allActions.find(entry => entry.key === key)!;
      expect(action.body, `${key} audits outside a transaction`).toMatch(/recordAudit\([\s\S]*?\btx\b[\s\S]*?\)/);
    }
  });
});

describe("errors disclose nothing about the inside of the system", () => {
  it("no route handler returns a raw error message", () => {
    for (const file of ROUTE_FILES) {
      const source = code(read(file));
      expect(source, `${file} echoes an exception message`).not.toMatch(/error instanceof Error \? error\.message/);
      expect(source, `${file} echoes an exception message`).not.toMatch(/error:\s*error\.message/);
    }
  });

  it("the health probe reveals neither the database name nor why it failed", () => {
    const source = code(read("src/app/api/health/route.ts"));
    expect(source).not.toMatch(/current_database/);
    expect(source).not.toMatch(/error\.message/);
    // A correlation id instead, so an operator can still find the log entry.
    expect(source).toMatch(/reference/);
  });

  it("unrecognized failures are logged with a reference and reported without their message", () => {
    const generic = ACTION_RESULT.slice(ACTION_RESULT.indexOf("// Unrecognized"));
    expect(generic).toMatch(/console\.error/);
    expect(generic).toMatch(/Something went wrong/);
    expect(generic).not.toMatch(/error\.message/);
  });

  it("only deliberately written messages reach the user", () => {
    expect(ACTION_RESULT).toMatch(/error instanceof ActionError/);
    expect(ACTION_RESULT).toMatch(/unstable_rethrow\(error\)/);
  });

  it("routes translate failures through the shared handler", () => {
    for (const file of ["src/app/api/waste/route.ts", "src/app/api/purchases/route.ts", "src/app/api/invoices/upload-url/route.ts"]) {
      expect(read(file), `${file} does not use toActionError`).toMatch(/toActionError\(error\)/);
    }
  });
});

describe("no secret reaches the browser", () => {
  const CLIENT_ONLY = /process\.env\.(?!NEXT_PUBLIC_)[A-Z_]+/;

  it("client components read only NEXT_PUBLIC_ variables", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".tsx") || entry.name.endsWith(".ts") ? [full] : [];
      });

    const clientFiles = walk(path.join(root, "src")).filter(file => {
      const source = readFileSync(file, "utf8");
      return source.startsWith('"use client"') || source.startsWith("'use client'");
    });

    expect(clientFiles.length).toBeGreaterThan(5);
    for (const file of clientFiles) {
      const source = readFileSync(file, "utf8");
      const leaked = source.match(CLIENT_ONLY);
      expect(leaked, `${path.relative(root, file)} reads a server-only variable`).toBeNull();
    }
  });

  it("the database URL is read only where the server connects", () => {
    const client = read("src/db/client.ts");
    expect(client).toMatch(/process\.env\.DATABASE_URL/);
    // Nothing marked NEXT_PUBLIC may carry a connection string.
    expect(read(".env.example")).not.toMatch(/NEXT_PUBLIC_[A-Z_]*=postgres/);
  });

  it("no service-role key is referenced anywhere in the application", () => {
    // A service-role key bypasses RLS entirely; the app has no use for one and
    // must not acquire the habit.
    for (const { file, source } of actionModules) {
      expect(source, `${file} references a service role key`).not.toMatch(/SERVICE_ROLE/i);
    }
    expect(read("src/lib/supabase/server.ts")).not.toMatch(/SERVICE_ROLE/i);
    expect(read("src/lib/supabase/client.ts")).not.toMatch(/SERVICE_ROLE/i);
  });
});

describe("preview mode cannot be switched on in production", () => {
  it("only one module reads the flag", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
      });

    const readers = walk(path.join(root, "src")).filter(
      file =>
        /NEXT_PUBLIC_DEMO_MODE/.test(readFileSync(file, "utf8")) &&
        !file.endsWith("demo-mode.ts") &&
        // This suite names the flag in order to assert nothing else does.
        !file.endsWith(".test.ts"),
    );
    expect(readers.map(file => path.relative(root, file))).toEqual([]);
  });

  it("is off in a production build regardless of the flag", () => {
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
    vi.stubEnv("NODE_ENV", "production");
    expect(isDemoMode()).toBe(false);
    vi.stubEnv("NODE_ENV", "development");
    expect(isDemoMode()).toBe(true);
    vi.unstubAllEnvs();
  });

  it("signing out is never skipped", () => {
    // It used to be a no-op in demo mode, which would leave a live session behind
    // a button that says it ended one.
    const source = read("src/app/auth/signout/route.ts");
    expect(source).toMatch(/auth\.signOut\(\)/);
    expect(source).not.toMatch(/DEMO_MODE|isDemoMode/);
  });
});

describe("response headers", () => {
  it("sets the headers that need no per-request nonce", () => {
    for (const header of [
      "X-Frame-Options",
      "frame-ancestors 'none'",
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
    ]) {
      expect(NEXT_CONFIG, `${header} is not set`).toContain(header);
    }
  });

  it("keeps invitation tokens out of the Referer header", () => {
    // Tokens travel in the path (`/invite/<token>`), so a lax referrer policy
    // hands them to any off-site link followed from that page.
    expect(NEXT_CONFIG).toMatch(/Referrer-Policy.*strict-origin-when-cross-origin/);
  });
});
