-- Run after supabase/rls.sql. Safe to re-run.
insert into storage.buckets (id, name, public)
values ('invoices', 'invoices', false)
on conflict (id) do update set public = false;

-- Reading follows tenant membership. Writing follows `manage_purchasing`, the
-- same owner/manager/inventory role check enforced by the signed-upload endpoint.
-- Without the role predicate, any signed-in organization member could bypass the
-- endpoint and write directly through the Supabase Storage API.
drop policy if exists "organization members upload invoices" on storage.objects;
create policy "organization members upload invoices"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'invoices'
  and public.can_manage_purchasing(
    ((storage.foldername(name))[1])::uuid,
    ((storage.foldername(name))[2])::uuid
  )
);

drop policy if exists "organization members read invoices" on storage.objects;
create policy "organization members read invoices"
on storage.objects for select to authenticated
using (
  bucket_id = 'invoices'
  and public.can_access_location(
    ((storage.foldername(name))[1])::uuid,
    ((storage.foldername(name))[2])::uuid
  )
);

drop policy if exists "organization members update invoices" on storage.objects;
create policy "organization members update invoices"
on storage.objects for update to authenticated
using (
  bucket_id = 'invoices'
  and public.can_manage_purchasing(
    ((storage.foldername(name))[1])::uuid,
    ((storage.foldername(name))[2])::uuid
  )
)
with check (
  bucket_id = 'invoices'
  and public.can_manage_purchasing(
    ((storage.foldername(name))[1])::uuid,
    ((storage.foldername(name))[2])::uuid
  )
);

drop policy if exists "organization members delete invoices" on storage.objects;
create policy "organization members delete invoices"
on storage.objects for delete to authenticated
using (
  bucket_id = 'invoices'
  and public.can_manage_purchasing(
    ((storage.foldername(name))[1])::uuid,
    ((storage.foldername(name))[2])::uuid
  )
);
