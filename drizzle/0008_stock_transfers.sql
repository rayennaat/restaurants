-- Stock transfers between locations.
--
-- A transfer is a document, not a balance: it explains why stock left one
-- kitchen and arrived at another, while `stock_movements` remains the only
-- thing that decides what is on hand — the same split stock counts use.
--
-- The `movement_type` enum already carries 'transfer_in' and 'transfer_out'
-- since migration 0000; this migration only adds the two tables that describe
-- the document. The movement types themselves need no change.
--
-- TWO LEGS, POSTED AT DIFFERENT TIMES. Sending writes one 'transfer_out' per
-- line at the source. Receiving writes one 'transfer_in' per line at the
-- destination. Between the two the goods are in transit: deliberately in
-- neither location's balance, because neither shelf physically holds them. A
-- van that never arrives shows up as a transfer stuck in 'sent' rather than as
-- stock silently existing in two places.

--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "transfer_status" AS ENUM('draft', 'sent', 'received', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_location_id" uuid NOT NULL,
	"destination_location_id" uuid NOT NULL,
	"status" "transfer_status" DEFAULT 'draft' NOT NULL,
	"reference" text,
	"note" text,
	"created_by" uuid,
	"sent_by" uuid,
	"sent_at" timestamp with time zone,
	"received_by" uuid,
	"received_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_transfer_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"quantity" numeric(18, 3) NOT NULL,
	"unit_code" text,
	"base_quantity" numeric(18, 6) NOT NULL,
	"unit_cost_millis" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_source_location_id_locations_id_fk"
    FOREIGN KEY ("source_location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- RESTRICT, not CASCADE: deleting a location must never silently erase the
-- history of stock that moved through it. Archiving is the supported way to
-- retire a site.
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_destination_location_id_locations_id_fk"
    FOREIGN KEY ("destination_location_id") REFERENCES "public"."locations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_transfer_id_stock_transfers_id_fk"
    FOREIGN KEY ("transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- RESTRICT, not CASCADE: deleting an ingredient must never erase transfer
-- history. The line snapshots its name-free identity and the value that moved.
DO $$ BEGIN
  ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_ingredient_id_ingredients_id_fk"
    FOREIGN KEY ("ingredient_id") REFERENCES "public"."ingredients"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- The ledger is scoped to a location, so a transfer whose two ends are the same
-- site would post a + and a − that cancel — and would be a document with no
-- meaning. Rejected outright rather than allowed to cancel to zero.
DO $$ BEGIN
  ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_distinct_locations"
    CHECK ("source_location_id" <> "destination_location_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- The document may record fractions of a unit (a 0.5 kg of beef), but never
-- nothing and never a negative — a negative line would be a second waste record
-- wearing a transfer's clothes.
DO $$ BEGIN
  ALTER TABLE "stock_transfer_items" ADD CONSTRAINT "stock_transfer_items_quantity_positive"
    CHECK ("quantity" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- The list screen filters by direction and status, so each direction gets the
-- index its filter needs.
CREATE INDEX IF NOT EXISTS "stock_transfers_org_idx" ON "stock_transfers" ("organization_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfers_source_idx" ON "stock_transfers" ("organization_id", "source_location_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfers_destination_idx" ON "stock_transfers" ("organization_id", "destination_location_id", "status");

--> statement-breakpoint
-- One line per ingredient: two lines for the same ingredient would be two
-- answers to "how much beef is moving".
CREATE UNIQUE INDEX IF NOT EXISTS "stock_transfer_items_transfer_ingredient_uidx"
  ON "stock_transfer_items" ("transfer_id", "ingredient_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfer_items_transfer_idx" ON "stock_transfer_items" ("transfer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_transfer_items_ingredient_idx" ON "stock_transfer_items" ("ingredient_id");
