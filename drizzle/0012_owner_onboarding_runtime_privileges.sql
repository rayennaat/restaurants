-- The application runtime bypasses RLS and needs to validate and atomically
-- claim owner onboarding tokens. Token issuance remains on the migration role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platepilot_runtime') THEN
    GRANT SELECT, UPDATE ON TABLE public.owner_onboarding_tokens TO platepilot_runtime;
  END IF;
END $$;
