import postgres from "postgres";

/**
 * Security verification, against a real database.
 *
 * `src/server/security-regression.test.ts` proves the *code* asks the right
 * questions. This proves the *database* gives the right answers — which no unit
 * test can, because the answers come from row level security, table privileges,
 * check constraints and triggers, none of which exist inside Vitest.
 *
 * It is the script that found the audit's most serious issue: RLS was scoping
 * every request to the caller's organization exactly as designed, and that was
 * not enough, because `authenticated` also held INSERT/UPDATE/DELETE on every
 * table. Tenant isolation held; role and location authorization did not, since a
 * policy cannot see the permission matrix. Reading the SQL suggested it; running
 * it as a signed-in cook proved it.
 *
 * ## Everything happens inside one transaction that is always rolled back
 *
 * The script creates two throwaway organizations, exercises the boundary between
 * them, and aborts. Nothing is left behind and no existing row is read into an
 * assertion — so this is safe to run against a database with live data, which is
 * precisely when you most want to run it.
 *
 * ## How a probe decides
 *
 * "No error" does not mean "allowed". A statement an RLS policy filters out
 * succeeds while affecting zero rows, and an early draft of this script recorded
 * those as vulnerabilities. So every probe reports the rows it *affected*, and
 * the destructive ones additionally read the row back as `postgres` afterwards to
 * confirm the value did not move. A probe passes only when the attempt was
 * refused outright or provably changed nothing.
 *
 * Run locally with: npm run verify:security
 * Run against staging with: npm run verify:security:staging
 */

const CONNECTION = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
if (!CONNECTION) {
  console.error("Set DATABASE_URL (or DATABASE_MIGRATION_URL) before running the security probe.");
  process.exit(1);
}

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];
function check(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
}

/** The role a signed-in browser session uses through the Supabase Data API. */
const BROWSER_ROLE = "authenticated";
/** The role an unauthenticated visitor uses with the publishable key. */
const ANON_ROLE = "anon";

const sql = postgres(CONNECTION, { prepare: false, max: 1 });

async function main() {
  await sql
    .begin(async tx => {
      const stamp = Date.now();

      // ------------------------------------------------------------- fixture
      //
      // Two organizations that must never see each other, and one member of A
      // holding `kitchen` — the least privileged role that can still write
      // something, and the one that must not be able to touch money.
      const [orgA] = await tx`insert into organizations (name, slug) values ('Security Probe A', ${`sec-probe-a-${stamp}`}) returning id`;
      const [orgB] = await tx`insert into organizations (name, slug) values ('Security Probe B', ${`sec-probe-b-${stamp}`}) returning id`;

      const [siteA] = await tx`insert into locations (organization_id, name) values (${orgA.id}, 'A Main') returning id`;
      const [annexA] = await tx`insert into locations (organization_id, name) values (${orgA.id}, 'A Annex') returning id`;
      const [siteB] = await tx`insert into locations (organization_id, name) values (${orgB.id}, 'B Main') returning id`;

      // Not a real Supabase user: `organization_members.user_id` carries no
      // foreign key into `auth.users`, deliberately, so the probe never touches
      // the auth schema.
      const cook = "11111111-1111-4111-8111-111111111111";
      const outsider = "22222222-2222-4222-8222-222222222222";
      const inventoryUser = "44444444-4444-4444-8444-444444444444";
      await tx`
        insert into organization_members (organization_id, user_id, role, default_location_id)
        values
          (${orgA.id}, ${cook}, 'kitchen', ${siteA.id}),
          (${orgA.id}, ${inventoryUser}, 'inventory', ${siteA.id})`;

      const [beefA] = await tx`
        insert into ingredients (organization_id, name, base_unit_code, latest_unit_cost_millis)
        values (${orgA.id}, ${`Probe Beef A ${stamp}`}, 'kg', 30000) returning id`;
      const [beefB] = await tx`
        insert into ingredients (organization_id, name, base_unit_code, latest_unit_cost_millis)
        values (${orgB.id}, ${`Probe Beef B ${stamp}`}, 'kg', 30000) returning id`;
      const [supplierA] = await tx`
        insert into suppliers (organization_id, name) values (${orgA.id}, ${`Probe Supplier A ${stamp}`}) returning id`;
      const [supplierB] = await tx`
        insert into suppliers (organization_id, name) values (${orgB.id}, ${`Probe Supplier B ${stamp}`}) returning id`;
      const [recipeA] = await tx`
        insert into recipes (organization_id, name) values (${orgA.id}, ${`Probe Recipe A ${stamp}`}) returning id`;
      const [recipeB] = await tx`
        insert into recipes (organization_id, name) values (${orgB.id}, ${`Probe Recipe B ${stamp}`}) returning id`;
      const [burgerA] = await tx`
        insert into menu_items (organization_id, name, selling_price_millis)
        values (${orgA.id}, ${`Probe Burger A ${stamp}`}, 18000) returning id`;
      const [burgerB] = await tx`
        insert into menu_items (organization_id, name, selling_price_millis)
        values (${orgB.id}, ${`Probe Burger B ${stamp}`}, 18000) returning id`;
      await tx`
        insert into audit_logs (organization_id, user_id, action, entity_type)
        values (${orgA.id}, ${cook}, 'probe_seed', 'ingredient')`;
      // One ledger row, so the TRUNCATE probe below has something to lose: an
      // empty table cannot tell a refusal from a successful wipe.
      await tx`
        insert into stock_movements (organization_id, location_id, ingredient_id, type, quantity)
        values (${orgA.id}, ${siteA.id}, ${beefA.id}, 'purchase', '10')`;

      // ------------------------------------------------------ probe machinery

      /** Reads that must come back empty, and writes that must change nothing. */
      const asRole = async (
        role: string,
        name: string,
        statement: () => Promise<unknown>,
        options: { subject?: string; verify?: () => Promise<{ ok: boolean; detail: string }> } = {},
      ) => {
        await tx`savepoint probe`;
        let refusal = "";
        let affected = 0;
        try {
          await tx`set local role ${tx.unsafe(role)}`;
          if (options.subject) {
            // What `auth.uid()` reads. Setting it is how this impersonates a
            // signed-in member rather than merely a role.
            await tx.unsafe(`set local request.jwt.claims = '${JSON.stringify({ sub: options.subject, role })}'`);
          }
          const result = (await statement()) as { count?: number; length?: number };
          affected = result?.count ?? result?.length ?? 0;
        } catch (error) {
          refusal = (error as Error).message.split("\n")[0];
        }

        /**
         * Order matters twice here.
         *
         * A refused statement leaves the transaction aborted: Postgres rejects
         * every further command until the savepoint is rolled back, so the
         * read-back has to wait — and is unnecessary anyway, because a statement
         * that was refused wrote nothing.
         *
         * A statement that *succeeded* is the opposite: the roll back would undo
         * it, so the damage must be read while it is still there. Verifying after
         * the rollback would report "unchanged" for every vulnerability and turn
         * this script into one that always passes.
         */
        let verified = { ok: true, detail: "" };
        if (refusal) {
          await tx`rollback to savepoint probe`;
          await tx`reset role`;
        } else {
          await tx`reset role`;
          if (options.verify) verified = await options.verify();
          await tx`rollback to savepoint probe`;
        }

        const blocked = Boolean(refusal) || affected === 0;
        const pass = blocked && verified.ok;
        const how = refusal
          ? `refused: ${refusal.slice(0, 74)}`
          : affected === 0
            ? "no rows affected"
            : `AFFECTED ${affected} ROW(S)`;
        check(`[${role}] ${name}`, pass, verified.detail ? `${how}; ${verified.detail}` : how);
      };

      /** Confirms a value is unchanged, for probes whose damage would be silent. */
      const unchanged = (label: string, read: () => Promise<unknown>, expected: unknown) => async () => {
        const actual = await read();
        return {
          ok: String(actual) === String(expected),
          detail: `${label} still ${String(actual)}`,
        };
      };

      const menuPrice = async () => {
        const [row] = await tx`select selling_price_millis as v from menu_items where id = ${burgerA.id}`;
        return row?.v ?? "deleted";
      };
      const ingredientCost = async (id: string) => {
        const [row] = await tx`select latest_unit_cost_millis as v from ingredients where id = ${id}`;
        return row?.v ?? "deleted";
      };
      const auditRows = async () => {
        const [row] = await tx`select count(*)::int as v from audit_logs where organization_id = ${orgA.id}`;
        return row.v;
      };
      const memberRole = async () => {
        const [row] = await tx`select role as v from organization_members where organization_id = ${orgA.id} and user_id = ${cook}`;
        return row?.v ?? "removed";
      };

      // ------------------------------------------------- 1. tenant isolation

      await asRole(BROWSER_ROLE, "cross-tenant read: select another org's ingredient", () => tx`select id from ingredients where id = ${beefB.id}`, { subject: cook });
      await asRole(BROWSER_ROLE, "cross-tenant read: select another org's menu", () => tx`select id from menu_items where organization_id = ${orgB.id}`, { subject: cook });
      await asRole(BROWSER_ROLE, "cross-tenant read: select another org's locations", () => tx`select id from locations where organization_id = ${orgB.id}`, { subject: cook });
      await asRole(BROWSER_ROLE, "cross-tenant read: select another org's organization row", () => tx`select id from organizations where id = ${orgB.id}`, { subject: cook });

      await asRole(BROWSER_ROLE, "cross-tenant write: insert an ingredient into another org", () => tx`
        insert into ingredients (organization_id, name, base_unit_code)
        values (${orgB.id}, ${`evil ${stamp}`}, 'kg') returning id`, { subject: cook });
      await asRole(BROWSER_ROLE, "cross-tenant write: reprice another org's ingredient", () => tx`
        update ingredients set latest_unit_cost_millis = 1 where id = ${beefB.id}`, {
        subject: cook,
        verify: unchanged("org B cost", () => ingredientCost(beefB.id), 30000),
      });
      await asRole(BROWSER_ROLE, "cross-tenant write: delete another org's ingredient", () => tx`
        delete from ingredients where id = ${beefB.id}`, {
        subject: cook,
        verify: unchanged("org B cost", () => ingredientCost(beefB.id), 30000),
      });
      await asRole(BROWSER_ROLE, "cross-tenant write: post a movement at another org's location", () => tx`
        insert into stock_movements (organization_id, location_id, ingredient_id, type, quantity)
        values (${orgB.id}, ${siteB.id}, ${beefB.id}, 'manual_adjustment', '10') returning id`, { subject: cook });
      await asRole(BROWSER_ROLE, "cross-tenant write: file a sale against another org", () => tx`
        insert into sales (organization_id, location_id, total_millis) values (${orgB.id}, ${siteB.id}, 100000) returning id`, { subject: cook });

      // ------------------------------- 2. role authorization through the API
      //
      // Every one of these is a `kitchen` member acting inside their own
      // organization, so RLS is satisfied and cannot help. What must stop them is
      // having no privilege on the table at all.

      await asRole(BROWSER_ROLE, "role bypass: reprice the menu without manage_recipes", () => tx`
        update menu_items set selling_price_millis = 1 where id = ${burgerA.id}`, {
        subject: cook,
        verify: unchanged("menu price", menuPrice, 18000),
      });
      await asRole(BROWSER_ROLE, "role bypass: invent revenue without manage_sales", () => tx`
        insert into sales (organization_id, location_id, total_millis) values (${orgA.id}, ${siteA.id}, 500000) returning id`, { subject: cook });
      await asRole(BROWSER_ROLE, "role bypass: adjust stock without approval", () => tx`
        insert into stock_movements (organization_id, location_id, ingredient_id, type, quantity)
        values (${orgA.id}, ${siteA.id}, ${beefA.id}, 'manual_adjustment', '999999') returning id`, { subject: cook });
      await asRole(BROWSER_ROLE, "role bypass: rewrite an ingredient cost directly", () => tx`
        update ingredients set latest_unit_cost_millis = 1 where id = ${beefA.id}`, {
        subject: cook,
        verify: unchanged("own cost", () => ingredientCost(beefA.id), 30000),
      });
      await asRole(BROWSER_ROLE, "role bypass: approve a stock count by flipping its status", () => tx`
        insert into stock_counts (organization_id, location_id, status) values (${orgA.id}, ${siteA.id}, 'approved') returning id`, { subject: cook });

      // ------------------------------------------- 3. location authorization

      await asRole(BROWSER_ROLE, "location bypass: post a movement at an unassigned site", () => tx`
        insert into stock_movements (organization_id, location_id, ingredient_id, type, quantity)
        values (${orgA.id}, ${annexA.id}, ${beefA.id}, 'manual_adjustment', '5') returning id`, { subject: cook });
      await asRole(BROWSER_ROLE, "location bypass: read another site's sales", () => tx`
        select id from sales where organization_id = ${orgA.id} and location_id = ${annexA.id}`, { subject: cook });

      // ---------------------------------------------- 4. audit trail is fixed

      await asRole(BROWSER_ROLE, "audit tampering: delete the trail", () => tx`
        delete from audit_logs where organization_id = ${orgA.id}`, {
        subject: cook,
        verify: unchanged("audit rows", auditRows, 1),
      });
      await asRole(BROWSER_ROLE, "audit tampering: rewrite an entry", () => tx`
        update audit_logs set action = 'forged' where organization_id = ${orgA.id}`, {
        subject: cook,
        verify: unchanged("audit rows", auditRows, 1),
      });
      await asRole(BROWSER_ROLE, "audit tampering: forge an entry", () => tx`
        insert into audit_logs (organization_id, user_id, action, entity_type)
        values (${orgA.id}, null, 'forged', 'member') returning id`, { subject: cook });

      // The trigger, tested on the connection that holds BYPASSRLS — the one the
      // application itself uses. Privileges stop the browser; only this stops a
      // bug (or an operator) on the server side.
      for (const [name, statement] of [
        ["audit immutability: UPDATE refused even on the privileged connection", () => tx`update audit_logs set action = 'forged' where organization_id = ${orgA.id}`],
        ["audit immutability: DELETE refused even on the privileged connection", () => tx`delete from audit_logs where organization_id = ${orgA.id}`],
        ["audit immutability: TRUNCATE refused even on the privileged connection", () => tx`truncate audit_logs`],
      ] as const) {
        await tx`savepoint probe`;
        let refusal = "";
        try {
          await statement();
        } catch (error) {
          refusal = (error as Error).message.split("\n")[0];
        }
        await tx`rollback to savepoint probe`;
        check(`[postgres] ${name}`, Boolean(refusal), refusal ? `refused: ${refusal.slice(0, 74)}` : "PERMITTED — the trail can be rewritten");
      }

      // --------------------------------------- 5. privilege escalation paths

      await asRole(BROWSER_ROLE, "escalation: mint a manager invitation", () => tx`
        insert into organization_invitations (organization_id, email, role, token_hash, expires_at)
        values (${orgA.id}, 'attacker@evil.test', 'manager', ${`probe-hash-a-${stamp}`}, now() + interval '7 days') returning id`, { subject: cook });
      await asRole(BROWSER_ROLE, "escalation: mint an owner invitation", () => tx`
        insert into organization_invitations (organization_id, email, role, token_hash, expires_at)
        values (${orgA.id}, 'attacker@evil.test', 'owner', ${`probe-hash-b-${stamp}`}, now() + interval '7 days') returning id`, { subject: cook });
      await asRole(BROWSER_ROLE, "escalation: promote own membership to owner", () => tx`
        update organization_members set role = 'owner' where organization_id = ${orgA.id} and user_id = ${cook}`, {
        subject: cook,
        verify: unchanged("own role", memberRole, "kitchen"),
      });
      await asRole(BROWSER_ROLE, "escalation: join another organization", () => tx`
        insert into organization_members (organization_id, user_id, role) values (${orgB.id}, ${cook}, 'owner') returning user_id`, { subject: cook });
      await asRole(BROWSER_ROLE, "escalation: read the member roster", () => tx`
        select user_id from organization_members where organization_id = ${orgA.id} and user_id <> ${cook}`, { subject: cook });

      // -------------------------------------------------- 6. the outsider
      //
      // Anyone may sign up. A brand-new account belongs to no organization, and
      // must therefore see and touch nothing at all.

      await asRole(BROWSER_ROLE, "non-member: read an organization they never joined", () => tx`
        select id from ingredients where organization_id = ${orgA.id}`, { subject: outsider });
      await asRole(BROWSER_ROLE, "non-member: write into an organization they never joined", () => tx`
        insert into ingredients (organization_id, name, base_unit_code) values (${orgA.id}, ${`outsider ${stamp}`}, 'kg') returning id`, { subject: outsider });

      await asRole(ANON_ROLE, "unauthenticated: read ingredients", () => tx`select id from ingredients limit 1`);
      await asRole(ANON_ROLE, "unauthenticated: insert an ingredient", () => tx`
        insert into ingredients (organization_id, name, base_unit_code) values (${orgA.id}, ${`anon ${stamp}`}, 'kg') returning id`);
      await asRole(ANON_ROLE, "unauthenticated: delete ingredients", () => tx`
        delete from ingredients where organization_id = ${orgA.id}`, {
        verify: unchanged("own cost", () => ingredientCost(beefA.id), 30000),
      });
      // TRUNCATE is *not* covered by row level security: a role holding the
      // privilege empties the table whatever the policies say. PostgREST never
      // issues it, so this is about the grant, not about the API.
      await asRole(ANON_ROLE, "unauthenticated: TRUNCATE a table (RLS does not cover it)", () => tx`truncate stock_movements`, {
        // TRUNCATE reports no affected count, so "no rows affected" proves
        // nothing: only counting the rows afterwards distinguishes a refusal from
        // an emptied table.
        verify: async () => {
          const [row] = await tx`select count(*)::int as v from stock_movements`;
          return { ok: row.v >= 1, detail: `stock_movements rows ${row.v} (expected at least the probe's own)` };
        },
      });

      // ------------------------------------------ 7. constraints and triggers
      //
      // The application layer refuses all of these too. These assert the
      // database refuses them even if it is bypassed.

      const expectRejected = async (name: string, statement: () => Promise<unknown>) => {
        await tx`savepoint probe`;
        let refusal = "";
        try {
          await statement();
        } catch (error) {
          refusal = (error as Error).message.split("\n")[0];
        }
        await tx`rollback to savepoint probe`;
        check(name, Boolean(refusal), refusal ? `refused: ${refusal.slice(0, 74)}` : "ACCEPTED — the database allows an invalid state");
      };

      await expectRejected("constraint: an invitation may not grant owner", () => tx`
        insert into organization_invitations (organization_id, email, role, token_hash, expires_at)
        values (${orgA.id}, 'x@evil.test', 'owner', ${`probe-hash-c-${stamp}`}, now() + interval '7 days')`);

      await expectRejected("constraint: a sale line may not have a negative quantity", async () => {
        const [sale] = await tx`insert into sales (organization_id, location_id, total_millis) values (${orgA.id}, ${siteA.id}, 1000) returning id`;
        return tx`
          insert into sale_lines (sale_id, menu_item_id, menu_item_name, quantity, unit_price_millis, line_total_millis)
          values (${sale.id}, ${burgerA.id}, 'Probe', '-1', 1000, -1000)`;
      });

      await expectRejected("constraint: a sale line may not have a negative price", async () => {
        const [sale] = await tx`insert into sales (organization_id, location_id, total_millis) values (${orgA.id}, ${siteA.id}, 1000) returning id`;
        return tx`
          insert into sale_lines (sale_id, menu_item_id, menu_item_name, quantity, unit_price_millis, line_total_millis)
          values (${sale.id}, ${burgerA.id}, 'Probe', '1', -1000, -1000)`;
      });

      await expectRejected("constraint: a sale line is immutable once written", async () => {
        const [sale] = await tx`insert into sales (organization_id, location_id, total_millis) values (${orgA.id}, ${siteA.id}, 1000) returning id`;
        await tx`
          insert into sale_lines (sale_id, menu_item_id, menu_item_name, quantity, unit_price_millis, line_total_millis)
          values (${sale.id}, ${burgerA.id}, 'Probe', '1', 1000, 1000)`;
        return tx`update sale_lines set unit_price_millis = 99999 where sale_id = ${sale.id}`;
      });

      await expectRejected("constraint: stock may not transfer to the location it is already in", () => tx`
        insert into stock_transfers (organization_id, source_location_id, destination_location_id)
        values (${orgA.id}, ${siteA.id}, ${siteA.id})`);

      await expectRejected("constraint: a transfer line may not be negative", async () => {
        const [transfer] = await tx`
          insert into stock_transfers (organization_id, source_location_id, destination_location_id)
          values (${orgA.id}, ${siteA.id}, ${annexA.id}) returning id`;
        return tx`
          insert into stock_transfer_items (transfer_id, ingredient_id, quantity, base_quantity)
          values (${transfer.id}, ${beefA.id}, '-5', '-5')`;
      });

      await expectRejected("constraint: a counted quantity may not be negative", async () => {
        const [count] = await tx`insert into stock_counts (organization_id, location_id) values (${orgA.id}, ${siteA.id}) returning id`;
        return tx`
          insert into stock_count_items (stock_count_id, ingredient_id, system_quantity, counted_quantity)
          values (${count.id}, ${beefA.id}, '10', '-3')`;
      });

      await expectRejected("trigger: an approved stock count cannot be reopened", async () => {
        const [count] = await tx`
          insert into stock_counts (organization_id, location_id, status, approved_at)
          values (${orgA.id}, ${siteA.id}, 'approved', now()) returning id`;
        return tx`update stock_counts set status = 'counting' where id = ${count.id}`;
      });

      await expectRejected("trigger: an approved count's lines cannot be edited", async () => {
        const [count] = await tx`insert into stock_counts (organization_id, location_id) values (${orgA.id}, ${siteA.id}) returning id`;
        await tx`
          insert into stock_count_items (stock_count_id, ingredient_id, system_quantity, counted_quantity)
          values (${count.id}, ${beefA.id}, '10', '10')`;
        await tx`update stock_counts set status = 'submitted' where id = ${count.id}`;
        await tx`update stock_counts set status = 'approved', approved_at = now() where id = ${count.id}`;
        return tx`update stock_count_items set counted_quantity = '999' where stock_count_id = ${count.id}`;
      });

      await expectRejected("constraint: a rejected count must carry a reason", () => tx`
        insert into stock_counts (organization_id, location_id, status) values (${orgA.id}, ${siteA.id}, 'rejected')`);

      await expectRejected("constraint: the same external sale cannot be imported twice", async () => {
        const key = `probe-external-${stamp}`;
        await tx`insert into sales (organization_id, location_id, source, external_id, total_millis) values (${orgA.id}, ${siteA.id}, 'csv_import', ${key}, 1000)`;
        return tx`insert into sales (organization_id, location_id, source, external_id, total_millis) values (${orgA.id}, ${siteA.id}, 'csv_import', ${key}, 1000)`;
      });

      await expectRejected("constraint: a composition line targets exactly one of ingredient or preparation", () => tx`
        insert into menu_item_lines (menu_item_id, ingredient_id, component_recipe_id, quantity)
        values (${burgerA.id}, null, null, '1')`);

      // The application checks all of these before writing. The database must
      // restate them because the server connection bypasses RLS and a future code
      // path, migration, or operator command can otherwise create a row whose
      // organization disagrees with one of the rows it references.
      await expectRejected("tenant constraint: a membership cannot reference another org's location", () => tx`
        insert into organization_members (organization_id, user_id, role, default_location_id)
        values (${orgA.id}, ${`33333333-3333-4333-8333-${String(stamp).slice(-12).padStart(12, "0")}`}, 'kitchen', ${siteB.id})`);
      await expectRejected("tenant constraint: an invitation cannot reference another org's location", () => tx`
        insert into organization_invitations (organization_id, email, role, default_location_id, token_hash, expires_at)
        values (${orgA.id}, 'probe-location@example.test', 'kitchen', ${siteB.id}, ${`probe-cross-location-${stamp}`}, now() + interval '7 days')`);
      await expectRejected("tenant constraint: a supplier product cannot mix organizations", () => tx`
        insert into supplier_products (organization_id, supplier_id, ingredient_id)
        values (${orgA.id}, ${supplierB.id}, ${beefA.id})`);
      await expectRejected("tenant constraint: a purchase cannot use another org's location", () => tx`
        insert into purchases (organization_id, location_id, supplier_id)
        values (${orgA.id}, ${siteB.id}, ${supplierA.id})`);
      await expectRejected("tenant constraint: a purchase cannot use another org's supplier", () => tx`
        insert into purchases (organization_id, location_id, supplier_id)
        values (${orgA.id}, ${siteA.id}, ${supplierB.id})`);
      await expectRejected("tenant constraint: a purchase line cannot use another org's ingredient", async () => {
        const [purchase] = await tx`insert into purchases (organization_id, location_id) values (${orgA.id}, ${siteA.id}) returning id`;
        return tx`insert into purchase_items (purchase_id, ingredient_id, quantity, unit_cost_millis, line_total_millis) values (${purchase.id}, ${beefB.id}, '1', 1000, 1000)`;
      });
      await expectRejected("tenant constraint: a stock movement cannot use another org's ingredient", () => tx`
        insert into stock_movements (organization_id, location_id, ingredient_id, type, quantity)
        values (${orgA.id}, ${siteA.id}, ${beefB.id}, 'manual_adjustment', '1')`);
      await expectRejected("tenant constraint: waste cannot use another org's location", () => tx`
        insert into waste_entries (organization_id, location_id, ingredient_id, quantity, reason)
        values (${orgA.id}, ${siteB.id}, ${beefA.id}, '1', 'other')`);
      await expectRejected("tenant constraint: a recipe line cannot use another org's component", () => tx`
        insert into recipe_ingredients (recipe_id, component_recipe_id, quantity)
        values (${recipeA.id}, ${recipeB.id}, '1')`);
      await expectRejected("tenant constraint: a menu line cannot use another org's ingredient", () => tx`
        insert into menu_item_lines (menu_item_id, ingredient_id, quantity)
        values (${burgerA.id}, ${beefB.id}, '1')`);
      await expectRejected("tenant constraint: a sale cannot use another org's location", () => tx`
        insert into sales (organization_id, location_id, total_millis) values (${orgA.id}, ${siteB.id}, 1000)`);
      await expectRejected("tenant constraint: a sale line cannot use another org's menu item", async () => {
        const [sale] = await tx`insert into sales (organization_id, location_id, total_millis) values (${orgA.id}, ${siteA.id}, 1000) returning id`;
        return tx`insert into sale_lines (sale_id, menu_item_id, menu_item_name, quantity, unit_price_millis, line_total_millis) values (${sale.id}, ${burgerB.id}, 'Foreign', '1', 1000, 1000)`;
      });
      await expectRejected("tenant constraint: a stock count cannot use another org's location", () => tx`
        insert into stock_counts (organization_id, location_id) values (${orgA.id}, ${siteB.id})`);
      await expectRejected("tenant constraint: a stock count line cannot use another org's ingredient", async () => {
        const [count] = await tx`insert into stock_counts (organization_id, location_id) values (${orgA.id}, ${siteA.id}) returning id`;
        return tx`insert into stock_count_items (stock_count_id, ingredient_id, system_quantity) values (${count.id}, ${beefB.id}, '1')`;
      });
      await expectRejected("tenant constraint: an import cannot use another org's location", () => tx`
        insert into sales_imports (organization_id, location_id) values (${orgA.id}, ${siteB.id})`);
      await expectRejected("tenant constraint: a transfer cannot use another org's destination", () => tx`
        insert into stock_transfers (organization_id, source_location_id, destination_location_id)
        values (${orgA.id}, ${siteA.id}, ${siteB.id})`);
      await expectRejected("tenant constraint: a transfer line cannot use another org's ingredient", async () => {
        const [transfer] = await tx`insert into stock_transfers (organization_id, source_location_id, destination_location_id) values (${orgA.id}, ${siteA.id}, ${annexA.id}) returning id`;
        return tx`insert into stock_transfer_items (transfer_id, ingredient_id, quantity, base_quantity) values (${transfer.id}, ${beefB.id}, '1', '1')`;
      });

      // ------------------------------------------------- 8. configuration
      //
      // The inventory an auditor would otherwise gather by hand.

      /**
       * The one thing the browser role must still be able to do.
       *
       * Invoice uploads go to Supabase Storage, whose policies on
       * `storage.objects` call `public.is_org_member()`. Revoking table
       * privileges must not take that with it — and it does not, because the
       * function is SECURITY DEFINER and therefore reads
       * `organization_members` with its owner's rights, not the caller's. This
       * check exists so that reasoning is verified rather than assumed: if a
       * future tightening breaks uploads, it fails here rather than in a
       * restaurant's kitchen.
       */
      await tx`savepoint probe`;
      let membershipVisible: boolean | string = "error";
      let foreignVisible: boolean | string = "error";
      try {
        await tx`set local role ${tx.unsafe(BROWSER_ROLE)}`;
        await tx.unsafe(`set local request.jwt.claims = '${JSON.stringify({ sub: cook, role: BROWSER_ROLE })}'`);
        const [own] = await tx`select public.is_org_member(${orgA.id}) as v`;
        const [other] = await tx`select public.is_org_member(${orgB.id}) as v`;
        membershipVisible = own.v;
        foreignVisible = other.v;
      } catch (error) {
        membershipVisible = (error as Error).message.split("\n")[0];
      }
      await tx`rollback to savepoint probe`;
      await tx`reset role`;
      check(
        "storage still works: a member can evaluate their own membership",
        membershipVisible === true,
        `is_org_member(own) = ${String(membershipVisible)} — invoice upload policies depend on this`,
      );
      check(
        "storage stays scoped: a member cannot claim another organization",
        foreignVisible === false,
        `is_org_member(other) = ${String(foreignVisible)}`,
      );

      const storageAllowed = async (subject: string, expression: string) => {
        await tx`savepoint probe`;
        let value: boolean | string = "error";
        try {
          await tx`set local role ${tx.unsafe(BROWSER_ROLE)}`;
          await tx.unsafe(`set local request.jwt.claims = '${JSON.stringify({ sub: subject, role: BROWSER_ROLE })}'`);
          const [row] = await tx.unsafe(`select ${expression} as v`);
          value = row.v;
        } catch (error) {
          value = (error as Error).message.split("\n")[0];
        }
        await tx`rollback to savepoint probe`;
        await tx`reset role`;
        return value;
      };

      const kitchenCanUpload = await storageAllowed(cook, `public.can_manage_purchasing('${orgA.id}', '${siteA.id}')`);
      const kitchenCanReadOwn = await storageAllowed(cook, `public.can_access_location('${orgA.id}', '${siteA.id}')`);
      const kitchenCanReadAnnex = await storageAllowed(cook, `public.can_access_location('${orgA.id}', '${annexA.id}')`);
      const inventoryCanUpload = await storageAllowed(inventoryUser, `public.can_manage_purchasing('${orgA.id}', '${siteA.id}')`);
      const inventoryCanUploadAnnex = await storageAllowed(inventoryUser, `public.can_manage_purchasing('${orgA.id}', '${annexA.id}')`);
      check(
        "storage role: kitchen cannot write invoice files",
        kitchenCanUpload === false,
        `can_manage_purchasing(kitchen, own) = ${String(kitchenCanUpload)}`,
      );
      check(
        "storage location: kitchen reads own invoices but not a sibling site's",
        kitchenCanReadOwn === true && kitchenCanReadAnnex === false,
        `own=${String(kitchenCanReadOwn)}, sibling=${String(kitchenCanReadAnnex)}`,
      );
      check(
        "storage role: inventory can write invoice files at the assigned site",
        inventoryCanUpload === true,
        `can_manage_purchasing(inventory, own) = ${String(inventoryCanUpload)}`,
      );
      check(
        "storage location: inventory cannot write invoice files at a sibling site",
        inventoryCanUploadAnnex === false,
        `can_manage_purchasing(inventory, sibling) = ${String(inventoryCanUploadAnnex)}`,
      );

      const storagePolicies = await tx`
        select policyname, cmd, coalesce(qual, '') as using_expression, coalesce(with_check, '') as check_expression
        from pg_policies
        where schemaname = 'storage' and tablename = 'objects' and policyname like '%invoices'
        order by cmd`;
      const writePolicies = storagePolicies.filter(row => ["INSERT", "UPDATE", "DELETE"].includes(row.cmd));
      const writesUsePermission =
        writePolicies.length === 3 &&
        writePolicies.every(row => `${row.using_expression} ${row.check_expression}`.includes("can_manage_purchasing"));
      check(
        "storage policy: every invoice write enforces the purchasing role",
        writesUsePermission,
        writesUsePermission ? "INSERT, UPDATE and DELETE use can_manage_purchasing" : "one or more write policies use membership only",
      );

      const unprotected = await tx`
        select c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`;
      check(
        "configuration: every public table has RLS enabled",
        unprotected.length === 0,
        unprotected.length ? `missing: ${unprotected.map(row => row.table).join(", ")}` : "all tables protected",
      );

      const policyless = await tx`
        select c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
          and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)
        order by 1`;
      check(
        "configuration: every protected table has at least one policy",
        policyless.length === 0,
        policyless.length ? `no policy: ${policyless.map(row => row.table).join(", ")}` : "all tables have a policy",
      );

      const grants = await tx`
        select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
        from information_schema.role_table_grants
        where table_schema = 'public' and grantee in ('anon', 'authenticated')
        group by grantee, table_name order by grantee, table_name`;
      check(
        "configuration: browser roles hold no privileges on application tables",
        grants.length === 0,
        grants.length
          ? `${grants.length} grant(s) remain, e.g. ${grants[0].grantee} → ${grants[0].table_name} (${grants[0].privileges}). Re-run supabase/rls.sql.`
          : "anon and authenticated hold nothing",
      );

      const bypass = await tx`select rolname from pg_roles where rolbypassrls and rolname in ('anon', 'authenticated')`;
      check(
        "configuration: browser roles cannot bypass RLS",
        bypass.length === 0,
        bypass.length ? `BYPASSRLS: ${bypass.map(row => row.rolname).join(", ")}` : "neither role can bypass",
      );

      // Deliberate: rolls the whole fixture back.
      throw new Error("SECURITY_PROBE_ROLLBACK");
    })
    .catch(error => {
      if (!(error instanceof Error) || error.message !== "SECURITY_PROBE_ROLLBACK") throw error;
    });
}

main()
  .then(async () => {
    await sql.end();

    const failed = checks.filter(entry => !entry.pass);
    const width = Math.max(...checks.map(entry => entry.name.length));

    console.log("\nSecurity verification — every probe ran inside a transaction that was rolled back.\n");
    for (const entry of checks) {
      console.log(`${entry.pass ? "PASS" : "FAIL"}  ${entry.name.padEnd(width)}  ${entry.detail}`);
    }
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);

    if (failed.length) {
      console.error(`\n${failed.length} security check(s) failed:`);
      for (const entry of failed) console.error(`  - ${entry.name}: ${entry.detail}`);
      console.error("\nIf the failures are grant-related, apply supabase/rls.sql; if trigger-related, run npm run db:migrate.");
      process.exit(1);
    }
    console.log("No cross-tenant, role, location, audit or constraint weakness detected at the database layer.");
  })
  .catch(async error => {
    await sql.end().catch(() => {});
    console.error("security probe failed to run", error);
    process.exit(1);
  });
