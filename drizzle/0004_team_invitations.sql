-- Team management: staff invitations, and retiring the `viewer` role.
--
-- Two independent changes that ship together because both concern
-- `organization_members`:
--
--   1. `organization_invitations` — a pending offer to join an organization
--      with a role chosen by the inviter. Only the SHA-256 hash of the token is
--      stored, so a database leak yields no usable invitation links.
--
--   2. The `role` column loses its `'viewer'` default. `viewer` is retired at
--      the application layer (see MEMBER_ROLES in server/tenant); a value
--      cannot be dropped from a PostgreSQL enum type, so the label survives in
--      `member_role` but nothing reads or writes it. Dropping the default
--      matters more than dropping the label: it was the only way a membership
--      could acquire a role nobody chose.
--
-- Verified before writing: `select role, count(*) from organization_members
-- group by role` returned only `owner` (2 rows). The backfill below is
-- therefore expected to match nothing and exists so this migration is correct
-- on any database, including one restored from an older backup.

--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "invitation_status" AS ENUM('pending', 'accepted', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "member_role" NOT NULL,
	"default_location_id" uuid,
	"invited_by" uuid,
	"token_hash" text NOT NULL,
	"status" "invitation_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organization_invitations"
    ADD CONSTRAINT "organization_invitations_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "organization_invitations"
    ADD CONSTRAINT "organization_invitations_default_location_id_locations_id_fk"
    FOREIGN KEY ("default_location_id") REFERENCES "locations"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- An invitation must never grant ownership: ownership is transferred by an
-- explicit promotion that requires the `transfer_ownership` permission. The
-- database refuses it too, so a bug in the action layer cannot hand out a
-- workspace.
DO $$ BEGIN
  ALTER TABLE "organization_invitations"
    ADD CONSTRAINT "organization_invitations_role_not_owner_chk"
    CHECK ("role" <> 'owner');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_invitations_org_idx" ON "organization_invitations" ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_invitations_token_uidx" ON "organization_invitations" ("token_hash");

--> statement-breakpoint
-- One live invitation per address per organization. Partial, so a revoked or
-- accepted invitation never blocks re-inviting someone later.
CREATE UNIQUE INDEX IF NOT EXISTS "org_invitations_pending_email_uidx"
  ON "organization_invitations" ("organization_id", lower("email"))
  WHERE "status" = 'pending';

--> statement-breakpoint
-- Retire `viewer`: no membership may inherit it by omission from here on.
ALTER TABLE "organization_members" ALTER COLUMN "role" DROP DEFAULT;

--> statement-breakpoint
-- Any legacy `viewer` row becomes `accountant`, the closest surviving role:
-- reads everything, writes nothing.
UPDATE "organization_members" SET "role" = 'accountant' WHERE "role" = 'viewer';
