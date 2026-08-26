-- Row Level Security for the Supabase Data API.
--
-- Run this AFTER `npm run db:migrate`, and re-run it any time it changes.
--
-- SAFE TO RE-RUN. Every statement is idempotent: the function is CREATE OR
-- REPLACE, `enable row level security` is a no-op when already on, grants are
-- additive, and each policy is dropped-if-exists before being recreated.
-- PostgreSQL has no `CREATE POLICY IF NOT EXISTS`, so drop-then-create is the
-- only way to make a policy definition converge — which is why re-running an
-- earlier version of this file failed with "policy ... already exists" and left
-- everything after that line unapplied.
--
-- This script touches PERMISSIONS ONLY. It creates no tables, drops no tables,
-- and never reads, modifies or deletes a single application row.
--
-- Dropping a policy while RLS is enabled denies access rather than granting it,
-- so the brief moment between DROP and CREATE fails closed. The Supabase SQL
-- Editor also runs a submission in one transaction, so in practice no window is
-- observable at all.
--
-- What RLS does and does not do here:
--   * It answers "whose data is this" — tenant isolation through the Data API.
--   * It does NOT answer "what may this person do with it". Role permissions
--     (who may approve a stock count, invite staff, receive a purchase) are
--     enforced in the server actions, which run on a privileged connection.
--     Both layers matter: RLS protects the browser-facing API, the action layer
--     protects the application.
--
-- Which is exactly why the browser roles hold NO privileges on these tables —
-- see "least privilege" below. RLS alone would let any signed-in member reach
-- their organization's tables through the Data API with the *wrong role*: a cook
-- could reprice the menu or post a stock movement, because `is_org_member` is
-- true for them and a policy cannot see the permission matrix. Removing the
-- grant closes that path, and the policies remain as the second layer.

-- ---------------------------------------------------------------- membership

create or replace function public.is_org_member(target_org uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.organization_members m where m.organization_id = target_org and m.user_id = auth.uid()) $$;

revoke all on function public.is_org_member(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;

-- Storage paths carry organization/location as their first two folders. These
-- helpers apply the same location reach as server queries and actions: owner,
-- manager and accountant span the organization; inventory and kitchen are pinned
-- to their assigned location. Purchasing writes are narrower still.
create or replace function public.can_access_location(target_org uuid, target_location uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists(
    select 1 from public.organization_members m
    join public.locations l on l.id = target_location and l.organization_id = target_org
    where m.organization_id = target_org
      and m.user_id = auth.uid()
      and (m.role in ('owner', 'manager', 'accountant') or m.default_location_id = target_location)
  )
$$;

revoke all on function public.can_access_location(uuid, uuid) from public;
grant execute on function public.can_access_location(uuid, uuid) to authenticated;

create or replace function public.can_manage_purchasing(target_org uuid, target_location uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists(
    select 1 from public.organization_members m
    join public.locations l on l.id = target_location and l.organization_id = target_org
    where m.organization_id = target_org
      and m.user_id = auth.uid()
      and m.role in ('owner', 'manager', 'inventory')
      and (m.role in ('owner', 'manager') or m.default_location_id = target_location)
  )
$$;

revoke all on function public.can_manage_purchasing(uuid, uuid) from public;
grant execute on function public.can_manage_purchasing(uuid, uuid) to authenticated;

-- ------------------------------------------------------------ least privilege

-- The browser roles get NO privileges on application tables.
--
-- This application never reads or writes `public` through the Data API. The
-- browser uses Supabase for exactly two things — `auth` (sign-in, session) and
-- `storage` (invoice uploads) — and every application read and write goes
-- through a server component, server action or route handler on the pooled
-- `postgres` connection, which is where authentication, the role matrix and
-- location authorization are enforced together.
--
-- So the grant that used to live here was pure attack surface. RLS scopes a
-- request to the caller's organization, but it cannot express "a cook may not
-- reprice the menu": `is_org_member()` is true for every member whatever their
-- role. With `grant ... to authenticated` in place, any signed-in member could
-- take their own session token and, through the Data API:
--   * update `menu_items.selling_price_millis` without `manage_recipes`,
--   * insert `sales` and `stock_movements` without `manage_sales`,
--   * write rows for a location they are not assigned to,
--   * delete or forge `audit_logs` rows,
--   * mint an `organization_invitations` row granting `manager`.
-- All five were reproduced against this database before this section existed.
--
-- Revoking is also what closes TRUNCATE, which **row security does not cover at
-- all**: a role holding TRUNCATE empties a table regardless of any policy. That
-- privilege arrives on every new table through Supabase's default grants, so it
-- is revoked here together with the default itself.
--
-- Storage is unaffected: its policies live on `storage.objects` and only need
-- EXECUTE on `is_org_member`, granted above.
grant usage on schema public to authenticated;

revoke all on all tables in schema public from anon, authenticated;
-- These tables are server-only. The runtime role is granted access by the
-- migration, while browser roles remain denied.
revoke all on table public.owner_onboarding_tokens, public.user_profiles, public.platform_admins, public.platform_audit_logs from anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platepilot_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.owner_onboarding_tokens TO platepilot_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_profiles TO platepilot_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.platform_admins TO platepilot_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.platform_audit_logs TO platepilot_runtime;
    GRANT USAGE, SELECT ON SEQUENCE public.platform_audit_logs_id_seq TO platepilot_runtime;
  END IF;
END $$;
revoke all on all sequences in schema public from anon, authenticated;

-- Future tables must not silently re-acquire the grant. Supabase's project
-- bootstrap sets default privileges for the owning role; this withdraws them so
-- a table added by a later migration starts closed.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- -------------------------------------------------------------- enable RLS

-- Idempotent: enabling on an already-protected table changes nothing.
alter table public.organizations            enable row level security;
alter table public.locations                enable row level security;
alter table public.organization_members     enable row level security;
alter table public.organization_invitations enable row level security;
alter table public.units                    enable row level security;
alter table public.ingredients              enable row level security;
alter table public.suppliers                enable row level security;
alter table public.supplier_products        enable row level security;
alter table public.purchases                enable row level security;
alter table public.purchase_items           enable row level security;
alter table public.stock_movements          enable row level security;
alter table public.waste_entries            enable row level security;
alter table public.recipes                  enable row level security;
alter table public.recipe_ingredients       enable row level security;
alter table public.menu_items               enable row level security;
alter table public.menu_item_lines          enable row level security;
alter table public.stock_counts             enable row level security;
alter table public.stock_count_items        enable row level security;
alter table public.sales                    enable row level security;
alter table public.sale_lines               enable row level security;
alter table public.sales_imports            enable row level security;
alter table public.stock_transfers          enable row level security;
alter table public.stock_transfer_items     enable row level security;
alter table public.audit_logs               enable row level security;
alter table public.owner_onboarding_tokens  enable row level security;
alter table public.user_profiles            enable row level security;
alter table public.platform_admins          enable row level security;
alter table public.platform_audit_logs      enable row level security;

-- Platform tables are deliberately unreachable through the Data API. These
-- policies make that fail-closed intent explicit even if a future grant drifts.
drop policy if exists "no browser access to owner onboarding tokens" on public.owner_onboarding_tokens;
create policy "no browser access to owner onboarding tokens" on public.owner_onboarding_tokens
  for all to anon, authenticated using (false) with check (false);
drop policy if exists "no browser access to user profiles" on public.user_profiles;
create policy "no browser access to user profiles" on public.user_profiles
  for all to anon, authenticated using (false) with check (false);
drop policy if exists "no browser access to platform admins" on public.platform_admins;
create policy "no browser access to platform admins" on public.platform_admins
  for all to anon, authenticated using (false) with check (false);
drop policy if exists "no browser access to platform audit logs" on public.platform_audit_logs;
create policy "no browser access to platform audit logs" on public.platform_audit_logs
  for all to anon, authenticated using (false) with check (false);

-- ------------------------------------------------------------ root policies

drop policy if exists "members read organizations" on public.organizations;
create policy "members read organizations" on public.organizations
  for select to authenticated
  using (public.is_org_member(id));

-- A member sees their own membership rows only. Rendering the full team roster
-- goes through the server, which has already checked organization membership.
drop policy if exists "users read own memberships" on public.organization_members;
create policy "users read own memberships" on public.organization_members
  for select to authenticated
  using (user_id = auth.uid());

-- ------------------------------------------- tables owning an organization_id

-- One policy shape, applied to every table that carries `organization_id`
-- directly. Written as a loop so the rule cannot drift between tables, and so
-- adding a table means adding one name to this array.
do $$
declare
  target text;
begin
  foreach target in array array[
    'locations',
    'units',
    'ingredients',
    'suppliers',
    'supplier_products',
    'purchases',
    'stock_movements',
    'waste_entries',
    'recipes',
    'menu_items',
    'organization_invitations',
    'stock_counts',
    'sales',
    'sales_imports',
    'stock_transfers',
    'audit_logs'
  ]
  loop
    execute format('drop policy if exists "members access %1$s" on public.%1$I', target);
    execute format(
      'create policy "members access %1$s" on public.%1$I for all to authenticated '
      'using (public.is_org_member(organization_id)) '
      'with check (public.is_org_member(organization_id))',
      target
    );
  end loop;
end $$;

-- ------------------------------------------------------------ child policies

-- These tables carry no `organization_id` of their own; they reach their tenant
-- through the row that owns them.

drop policy if exists "members access purchase items" on public.purchase_items;
create policy "members access purchase items" on public.purchase_items
  for all to authenticated
  using       (exists(select 1 from public.purchases p where p.id = purchase_id and public.is_org_member(p.organization_id)))
  with check  (exists(select 1 from public.purchases p where p.id = purchase_id and public.is_org_member(p.organization_id)));

drop policy if exists "members access recipe ingredients" on public.recipe_ingredients;
create policy "members access recipe ingredients" on public.recipe_ingredients
  for all to authenticated
  using       (exists(select 1 from public.recipes r where r.id = recipe_id and public.is_org_member(r.organization_id)))
  with check  (exists(select 1 from public.recipes r where r.id = recipe_id and public.is_org_member(r.organization_id)));

-- Dish composition (migration 0003). Reaches its tenant through the menu item
-- that owns it, exactly like recipe_ingredients above.
drop policy if exists "members access menu item lines" on public.menu_item_lines;
create policy "members access menu item lines" on public.menu_item_lines
  for all to authenticated
  using       (exists(select 1 from public.menu_items m where m.id = menu_item_id and public.is_org_member(m.organization_id)))
  with check  (exists(select 1 from public.menu_items m where m.id = menu_item_id and public.is_org_member(m.organization_id)));

-- Stock count lines (migration 0005). Immutability of an approved count is a
-- database trigger, not a policy, so it holds on every connection including the
-- privileged one the server uses.
drop policy if exists "members access stock count items" on public.stock_count_items;
create policy "members access stock count items" on public.stock_count_items
  for all to authenticated
  using       (exists(select 1 from public.stock_counts c where c.id = stock_count_id and public.is_org_member(c.organization_id)))
  with check  (exists(select 1 from public.stock_counts c where c.id = stock_count_id and public.is_org_member(c.organization_id)));

-- Sale lines (migration 0006). Reach their tenant through the sale. Line
-- immutability is a database trigger rather than a policy, so it also holds on
-- the privileged connection the server uses — a sale is corrected by voiding it
-- and recording a new one, never by editing history.
-- Transfer lines (migration 0008). Reach their tenant through the transfer that
-- owns them, exactly like stock_count_items and sale_lines. Which *locations* a
-- member may transfer between is a role question, enforced in the action layer
-- on the privileged connection — RLS answers "whose data is this", not "what may
-- this person do with it".
drop policy if exists "members access stock transfer items" on public.stock_transfer_items;
create policy "members access stock transfer items" on public.stock_transfer_items
  for all to authenticated
  using       (exists(select 1 from public.stock_transfers t where t.id = transfer_id and public.is_org_member(t.organization_id)))
  with check  (exists(select 1 from public.stock_transfers t where t.id = transfer_id and public.is_org_member(t.organization_id)));

drop policy if exists "members access sale lines" on public.sale_lines;
create policy "members access sale lines" on public.sale_lines
  for all to authenticated
  using       (exists(select 1 from public.sales s where s.id = sale_id and public.is_org_member(s.organization_id)))
  with check  (exists(select 1 from public.sales s where s.id = sale_id and public.is_org_member(s.organization_id)));

-- Invitations (migration 0004) are covered by the organization_id loop above.
-- Note what is deliberately absent: nothing lets an unauthenticated visitor
-- read this table by token. Redemption runs server-side through the
-- `acceptInvitation` action on the privileged connection, which is how someone
-- who is not yet a member can be matched against a row they could never select
-- for themselves.

-- ------------------------------------------------------------ verification

-- Reports any public table left without RLS, protected but with no policy, or
-- still reachable by a browser role. All three are misconfigurations: the first
-- exposes rows through the Data API, the second silently denies all access to
-- them, the third re-opens the role-bypass this script exists to close.
do $$
declare
  unprotected text;
  policyless  text;
  granted     text;
begin
  select string_agg(c.relname, ', ' order by c.relname) into unprotected
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

  select string_agg(c.relname, ', ' order by c.relname) into policyless
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
     and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname);

  select string_agg(distinct g.table_name || ' (' || g.grantee || ')', ', ' order by g.table_name || ' (' || g.grantee || ')')
    into granted
    from information_schema.role_table_grants g
   where g.table_schema = 'public' and g.grantee in ('anon', 'authenticated');

  if unprotected is not null then
    raise warning 'Tables without RLS: %', unprotected;
  end if;
  if policyless is not null then
    raise warning 'Tables with RLS but no policy (all access denied): %', policyless;
  end if;
  if granted is not null then
    raise warning 'Browser roles still hold table privileges: %', granted;
  end if;
  if unprotected is null and policyless is null and granted is null then
    raise notice 'RLS applied: every public table is protected, has a policy, and is unreachable by anon/authenticated.';
  end if;
end $$;
