-- Auth user lifecycle hardening.
--
-- auth.users is the identity source of truth. public.user_profiles is an
-- application-owned mirror used by platform screens and tenant guards, so a
-- deleted Auth user must not remain visible as an active Yield user.

--> statement-breakpoint
DELETE FROM public.user_profiles profile
WHERE NOT EXISTS (
  SELECT 1 FROM auth.users auth_user WHERE auth_user.id = profile.user_id
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.user_profiles
    ADD CONSTRAINT user_profiles_auth_user_fk
    FOREIGN KEY (user_id)
    REFERENCES auth.users(id)
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.sync_user_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.user_profiles WHERE user_id = OLD.id;
    RETURN OLD;
  END IF;

  INSERT INTO public.user_profiles (user_id, email, email_confirmed_at, last_seen_at, status, updated_at)
  VALUES (NEW.id, lower(COALESCE(NEW.email, '')), NEW.email_confirmed_at, NEW.last_sign_in_at, 'active', now())
  ON CONFLICT (user_id) DO UPDATE SET
    email = EXCLUDED.email,
    email_confirmed_at = EXCLUDED.email_confirmed_at,
    last_seen_at = EXCLUDED.last_seen_at,
    updated_at = now();
  RETURN NEW;
END;
$$;

--> statement-breakpoint
DROP TRIGGER IF EXISTS sync_user_profile ON auth.users;

--> statement-breakpoint
CREATE TRIGGER sync_user_profile
AFTER INSERT OR UPDATE OF email, email_confirmed_at, last_sign_in_at OR DELETE ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.sync_user_profile();

--> statement-breakpoint
ALTER TYPE public.platform_audit_action ADD VALUE IF NOT EXISTS 'user_deactivated';
--> statement-breakpoint
ALTER TYPE public.platform_audit_action ADD VALUE IF NOT EXISTS 'user_reactivated';
--> statement-breakpoint
ALTER TYPE public.platform_audit_action ADD VALUE IF NOT EXISTS 'user_deleted';

--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platepilot_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_profiles TO platepilot_runtime;
  END IF;
END $$;
