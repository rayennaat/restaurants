CREATE TYPE "public"."organization_plan" AS ENUM('pilot', 'starter', 'restaurant', 'multi_location');--> statement-breakpoint
CREATE TYPE "public"."organization_status" AS ENUM('active', 'pilot', 'suspended', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."platform_audit_action" AS ENUM('owner_invitation_issued', 'owner_invitation_revoked', 'organization_plan_changed', 'organization_status_changed');--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan" "organization_plan" DEFAULT 'pilot' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "status" "organization_status" DEFAULT 'pilot' NOT NULL;--> statement-breakpoint
CREATE INDEX "organizations_status_idx" ON "organizations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "organizations_plan_idx" ON "organizations" USING btree ("plan");--> statement-breakpoint
CREATE TABLE "user_profiles" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "email_confirmed_at" timestamp with time zone,
  "last_seen_at" timestamp with time zone,
  "status" text DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "user_profiles_email_idx" ON "user_profiles" USING btree ("email");--> statement-breakpoint
CREATE INDEX "user_profiles_status_idx" ON "user_profiles" USING btree ("status");--> statement-breakpoint
CREATE TABLE "platform_admins" (
  "user_id" uuid PRIMARY KEY NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "platform_audit_logs" (
  "id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "platform_audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
  "actor_user_id" uuid NOT NULL,
  "organization_id" uuid,
  "action" "platform_audit_action" NOT NULL,
  "entity_id" uuid,
  "metadata" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "platform_audit_logs_org_idx" ON "platform_audit_logs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "platform_audit_logs_created_idx" ON "platform_audit_logs" USING btree ("created_at");--> statement-breakpoint

-- Keep the directory application-owned. This trigger is the only place that
-- reads auth.users; the application runtime never queries Supabase's private auth schema.
CREATE OR REPLACE FUNCTION public.sync_user_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, email, email_confirmed_at, last_seen_at, updated_at)
  VALUES (NEW.id, lower(COALESCE(NEW.email, '')), NEW.email_confirmed_at, NEW.last_sign_in_at, now())
  ON CONFLICT (user_id) DO UPDATE SET
    email = EXCLUDED.email,
    email_confirmed_at = EXCLUDED.email_confirmed_at,
    last_seen_at = EXCLUDED.last_seen_at,
    updated_at = now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS sync_user_profile ON auth.users;--> statement-breakpoint
CREATE TRIGGER sync_user_profile
AFTER INSERT OR UPDATE OF email, email_confirmed_at, last_sign_in_at ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.sync_user_profile();--> statement-breakpoint
INSERT INTO public.user_profiles (user_id, email, email_confirmed_at, last_seen_at)
SELECT id, lower(COALESCE(email, '')), email_confirmed_at, last_sign_in_at
FROM auth.users
ON CONFLICT (user_id) DO UPDATE SET
  email = EXCLUDED.email,
  email_confirmed_at = EXCLUDED.email_confirmed_at,
  last_seen_at = EXCLUDED.last_seen_at,
  updated_at = now();--> statement-breakpoint

-- Server runtime access only. Browser roles remain denied by the RLS policy script.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'platepilot_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.user_profiles TO platepilot_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.platform_admins TO platepilot_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.platform_audit_logs TO platepilot_runtime;
    GRANT USAGE, SELECT ON SEQUENCE public.platform_audit_logs_id_seq TO platepilot_runtime;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.owner_onboarding_tokens TO platepilot_runtime;
  END IF;
END $$;--> statement-breakpoint
REVOKE ALL ON TABLE public.user_profiles, public.platform_admins, public.platform_audit_logs FROM anon, authenticated;--> statement-breakpoint
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.platform_audit_logs ENABLE ROW LEVEL SECURITY;
