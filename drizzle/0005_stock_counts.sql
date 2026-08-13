-- Physical inventory counts and their variances.
--
-- A count is a document, not a mutation. Approving one emits
-- `stock_count_adjustment` movements into `stock_movements`; the ledger stays
-- the single source of truth for what is on hand, and the count explains why an
-- adjustment exists. Nothing here ever overwrites a balance.
--
-- `system_quantity` on each item is a snapshot taken when the line is created,
-- and the movement written at approval is the delta (counted − system) rather
-- than the counted figure. That ordering matters: if a delivery is received
-- between counting and approval, applying the delta lands on top of it, whereas
-- applying the counted figure would silently erase it.

--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "stock_count_status" AS ENUM('draft', 'counting', 'submitted', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"status" "stock_count_status" DEFAULT 'draft' NOT NULL,
	"reference" text,
	"note" text,
	"created_by" uuid,
	"submitted_by" uuid,
	"approved_by" uuid,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_count_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stock_count_id" uuid NOT NULL,
	"ingredient_id" uuid NOT NULL,
	"system_quantity" numeric(18, 4) NOT NULL,
	"counted_quantity" numeric(18, 4),
	"counted_unit_code" text,
	"unit_cost_millis" integer DEFAULT 0 NOT NULL,
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_location_id_locations_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stock_count_items" ADD CONSTRAINT "stock_count_items_stock_count_id_stock_counts_id_fk"
    FOREIGN KEY ("stock_count_id") REFERENCES "stock_counts"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "stock_count_items" ADD CONSTRAINT "stock_count_items_ingredient_id_ingredients_id_fk"
    FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- A physical count cannot be negative. The variance derived from it may be.
DO $$ BEGIN
  ALTER TABLE "stock_count_items" ADD CONSTRAINT "stock_count_items_counted_non_negative_chk"
    CHECK ("counted_quantity" IS NULL OR "counted_quantity" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- A rejection must say why; nothing else may carry a reason.
DO $$ BEGIN
  ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_rejection_reason_chk"
    CHECK (("status" = 'rejected' AND "rejection_reason" IS NOT NULL) OR ("status" <> 'rejected' AND "rejection_reason" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_counts_org_location_idx" ON "stock_counts" ("organization_id", "location_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_counts_status_idx" ON "stock_counts" ("organization_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_count_items_count_idx" ON "stock_count_items" ("stock_count_id");
--> statement-breakpoint
-- One line per ingredient per count: counting the same thing twice on one sheet
-- would double the adjustment at approval.
CREATE UNIQUE INDEX IF NOT EXISTS "stock_count_items_count_ingredient_uidx" ON "stock_count_items" ("stock_count_id", "ingredient_id");

--> statement-breakpoint
-- Approved counts are immutable. The action layer already refuses to edit one,
-- but approval writes irreversible ledger movements, so the database enforces it
-- too: a terminal count may never be edited or moved back to an open state.
CREATE OR REPLACE FUNCTION public.stock_counts_freeze_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Stock count % is % and cannot be modified. Create a new count instead.', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
DROP TRIGGER IF EXISTS stock_counts_freeze_terminal_trg ON public.stock_counts;
--> statement-breakpoint
CREATE TRIGGER stock_counts_freeze_terminal_trg
  BEFORE UPDATE ON public.stock_counts
  FOR EACH ROW EXECUTE FUNCTION public.stock_counts_freeze_terminal();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.stock_count_items_freeze_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status stock_count_status;
BEGIN
  SELECT status INTO parent_status FROM public.stock_counts
   WHERE id = COALESCE(NEW.stock_count_id, OLD.stock_count_id);
  IF parent_status IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Stock count is % and its lines cannot be modified.', parent_status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

--> statement-breakpoint
DROP TRIGGER IF EXISTS stock_count_items_freeze_terminal_trg ON public.stock_count_items;
--> statement-breakpoint
CREATE TRIGGER stock_count_items_freeze_terminal_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.stock_count_items
  FOR EACH ROW EXECUTE FUNCTION public.stock_count_items_freeze_terminal();
