-- Make the audit trail append-only, in the database.
--
-- `audit_logs` is the record of who changed what: role grants, member removals,
-- approved stock counts, voided sales, deleted units. Everything else in this
-- schema can be reconstructed from its own history; this table *is* the history,
-- so it is the one table where a successful UPDATE or DELETE is always a
-- problem — either a bug, or somebody covering their tracks.
--
-- The application never issues either. `recordAudit` only inserts. So this
-- trigger costs nothing in normal operation and turns "no code path does that"
-- into "no connection can", including:
--
--   * the pooled `postgres` connection the server actions use, which holds
--     BYPASSRLS and would sail through any policy written instead of this;
--   * the Data API, whose table grants migration-adjacent `supabase/rls.sql`
--     now revokes — but a policy and a grant are configuration, and this is not.
--
-- Verified before writing: no application code, script or cron job updates or
-- deletes from `audit_logs` (`supabase/cron.sql` touches `ingredients` only),
-- and `organization_id` carries no foreign key, so deleting an organization does
-- not cascade here. There is therefore no legitimate writer to break.
--
-- ## If a retention policy is ever needed
--
-- Pruning rows older than N years is a deliberate, one-off, operator action:
--
--   alter table public.audit_logs disable trigger audit_logs_append_only_trg;
--   delete from public.audit_logs where created_at < now() - interval '7 years';
--   alter table public.audit_logs enable trigger audit_logs_append_only_trg;
--
-- Having to write that down is the point: it is a decision with a paper trail,
-- not a DELETE that slips through in a hotfix.

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.audit_logs_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'check_violation',
          HINT = 'Correct the record with a new audit entry; history is never rewritten.';
END $$;

--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_logs_append_only_trg ON public.audit_logs;

--> statement-breakpoint
-- Statement-level, not per row: a DELETE matching a million rows should be
-- refused once rather than a million times, and an UPDATE that matches nothing
-- is still an attempt worth refusing.
CREATE TRIGGER audit_logs_append_only_trg
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_logs_append_only();
