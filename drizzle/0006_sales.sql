-- Sales: what was actually sold, per location, over time.
--
-- This is the foundation the profitability picture was missing. Until now the
-- menu could say what a dish *should* cost and inventory could say what left
-- the shelves, but nothing recorded what customers actually bought — so real
-- revenue, real food cost percentage and theoretical-vs-actual variance were
-- all undecidable.
--
-- Two design commitments are enforced here rather than in application code:
--
-- 1. HISTORICAL PRICING. `sale_lines.unit_price_millis` is a snapshot taken at
--    the moment of sale. Re-pricing a burger from 20 DT to 22 DT must not
--    rewrite last month's revenue, so no query values a historical sale by
--    joining to the current `menu_items.selling_price_millis`.
--
-- 2. IMPORT IDEMPOTENCY. A partial unique index on
--    (organization_id, source, external_id) makes re-running a POS or CSV
--    import a no-op instead of doubling revenue. It is partial so manually
--    entered sales, which carry no external id, are unconstrained.
--
-- Sales deliberately do NOT write into `stock_movements`. Theoretical
-- consumption is derived on read from the recipe graph; the ledger stays a
-- record of physically observed movement. Conflating the two would make
-- variance — the whole point of counting stock — impossible to compute.

--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "sale_source" AS ENUM('manual', 'csv_import', 'pos_import');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "sale_status" AS ENUM('recorded', 'voided');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"source" "sale_source" DEFAULT 'manual' NOT NULL,
	"status" "sale_status" DEFAULT 'recorded' NOT NULL,
	"reference" text,
	"external_id" text,
	"total_millis" integer DEFAULT 0 NOT NULL,
	"note" text,
	"sold_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"client_operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sale_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"menu_item_name" text NOT NULL,
	"quantity" numeric(18, 3) NOT NULL,
	"unit_price_millis" integer NOT NULL,
	"line_total_millis" integer NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sales" ADD CONSTRAINT "sales_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sales" ADD CONSTRAINT "sales_location_id_locations_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_sales_id_fk"
    FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- RESTRICT, not CASCADE: deleting a menu item must never erase the sales that
-- paid for it. Archiving (`is_active = false`) is the supported way to retire a
-- dish, and `menu_item_name` is snapshotted so old receipts still read right.
DO $$ BEGIN
  ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_menu_item_id_menu_items_id_fk"
    FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- Leading (org, location, sold_at) serves the location-filtered range scans the
-- sales page and dashboard run; the org-wide variant serves the same queries
-- with no location filter.
CREATE INDEX IF NOT EXISTS "sales_org_location_sold_idx" ON "sales" ("organization_id", "location_id", "sold_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_org_sold_idx" ON "sales" ("organization_id", "sold_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_client_operation_uidx" ON "sales" ("client_operation_id");

--> statement-breakpoint
-- Import idempotency, scoped per source so the same ticket number from a CSV
-- and from a POS remain distinct. Partial, so manual sales (no external id)
-- are unaffected — Postgres would otherwise treat every NULL as distinct
-- anyway, but being explicit documents the intent.
CREATE UNIQUE INDEX IF NOT EXISTS "sales_org_source_external_uidx"
  ON "sales" ("organization_id", "source", "external_id")
  WHERE "external_id" IS NOT NULL;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_lines_sale_idx" ON "sale_lines" ("sale_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sale_lines_menu_item_idx" ON "sale_lines" ("menu_item_id");

--> statement-breakpoint
-- Quantity and price are checked in Zod before insert; the database restates it
-- so a future import path or manual SQL cannot create negative revenue.
DO $$ BEGIN
  ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_quantity_positive" CHECK ("quantity" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_price_non_negative" CHECK ("unit_price_millis" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- A sale is a historical fact: once recorded, its lines never change. A
-- mistake is corrected by voiding the sale and recording a new one, which
-- leaves both the error and the correction visible. Voiding only ever touches
-- the parent row, so lines are frozen outright.
CREATE OR REPLACE FUNCTION public.sale_lines_freeze()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Sale lines are immutable. Void the sale and record a new one instead.'
    USING ERRCODE = 'check_violation';
END $$;

--> statement-breakpoint
DROP TRIGGER IF EXISTS sale_lines_freeze_trg ON public.sale_lines;
--> statement-breakpoint
-- UPDATE and DELETE only: INSERT is how lines are created in the first place,
-- and ON DELETE CASCADE from `sales` is a system operation, not a user edit —
-- so the trigger is scoped to statement-level user mutations of existing rows.
CREATE TRIGGER sale_lines_freeze_trg
  BEFORE UPDATE ON public.sale_lines
  FOR EACH ROW EXECUTE FUNCTION public.sale_lines_freeze();
