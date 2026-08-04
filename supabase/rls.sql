-- Run this AFTER `npm run db:migrate` in Supabase SQL Editor.
create or replace function public.is_org_member(target_org uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.organization_members m where m.organization_id = target_org and m.user_id = auth.uid()) $$;

revoke all on function public.is_org_member(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

alter table public.organizations enable row level security;
alter table public.locations enable row level security;
alter table public.organization_members enable row level security;
alter table public.units enable row level security;
alter table public.ingredients enable row level security;
alter table public.suppliers enable row level security;
alter table public.supplier_products enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_items enable row level security;
alter table public.stock_movements enable row level security;
alter table public.waste_entries enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.menu_items enable row level security;
alter table public.audit_logs enable row level security;

create policy "members read organizations" on public.organizations for select to authenticated using (public.is_org_member(id));
create policy "users read own memberships" on public.organization_members for select to authenticated using (user_id = auth.uid());

-- Standard organization_id tables.
do $$
declare table_name text;
begin
  foreach table_name in array array['locations','units','ingredients','suppliers','supplier_products','purchases','stock_movements','waste_entries','recipes','menu_items','audit_logs']
  loop
    execute format('create policy "members access %1$s" on public.%1$I for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id))', table_name);
  end loop;
end $$;

-- Child tables inherit tenant access through their parent.
create policy "members access purchase items" on public.purchase_items for all to authenticated
using (exists(select 1 from public.purchases p where p.id = purchase_id and public.is_org_member(p.organization_id)))
with check (exists(select 1 from public.purchases p where p.id = purchase_id and public.is_org_member(p.organization_id)));
create policy "members access recipe ingredients" on public.recipe_ingredients for all to authenticated
using (exists(select 1 from public.recipes r where r.id = recipe_id and public.is_org_member(r.organization_id)))
with check (exists(select 1 from public.recipes r where r.id = recipe_id and public.is_org_member(r.organization_id)));
