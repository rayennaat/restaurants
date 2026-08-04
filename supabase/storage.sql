-- Run after supabase/rls.sql.
insert into storage.buckets (id, name, public)
values ('invoices', 'invoices', false)
on conflict (id) do update set public = false;

create policy "organization members upload invoices"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'invoices'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
);

create policy "organization members read invoices"
on storage.objects for select to authenticated
using (
  bucket_id = 'invoices'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
);

create policy "organization members update invoices"
on storage.objects for update to authenticated
using (
  bucket_id = 'invoices'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
)
with check (
  bucket_id = 'invoices'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
);

create policy "organization members delete invoices"
on storage.objects for delete to authenticated
using (
  bucket_id = 'invoices'
  and public.is_org_member(((storage.foldername(name))[1])::uuid)
);
