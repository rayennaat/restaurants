CREATE TYPE "public"."owner_onboarding_status" AS ENUM('pending', 'claimed', 'revoked');--> statement-breakpoint
CREATE TABLE "owner_onboarding_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "token_hash" text NOT NULL,
  "status" "owner_onboarding_status" DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "claimed_at" timestamp with time zone,
  "claimed_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "owner_onboarding_tokens_hash_uidx" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE INDEX "owner_onboarding_tokens_email_idx" ON "owner_onboarding_tokens" USING btree ("email");
--> statement-breakpoint
ALTER TABLE "owner_onboarding_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "owner_onboarding_tokens" FROM anon, authenticated;
