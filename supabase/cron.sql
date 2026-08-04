-- Optional example after enabling pg_cron in Supabase.
-- This only creates a daily maintenance job; notification delivery should call an Edge Function or HTTP endpoint.
select cron.schedule('platepilot-daily-maintenance', '15 2 * * *', $$
  update public.ingredients set updated_at = now() where is_active = true and updated_at < now() - interval '30 days';
$$);
