-- CSV / POS sales import.
--
-- The sales tables already carried everything an import needs to be *safe*:
-- `source` distinguishes imported revenue from hand-entered revenue, and the
-- partial unique index on (organization_id, source, external_id) makes
-- re-running an export a no-op instead of doubling takings. Migration 0006
-- built both in anticipation of this feature, so nothing here changes how a
-- sale is stored.
--
-- What was missing is the record of the *run*. Knowing a sale came from a CSV
-- does not answer the questions asked after an import goes wrong: which file,
-- who uploaded it, how many rows were rejected, and why. `sales_imports` is
-- that receipt, and `sales.import_id` ties each created sale back to it.
--
-- TRANSACTIONAL BY CONSTRUCTION. The receipt row is inserted in the same
-- transaction as the sales it describes, so a failed import leaves neither
-- sales nor a row claiming it succeeded. That is why `sales_import_status` has
-- no `pending` value — an uncommitted run is invisible by design.

--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "sales_import_status" AS ENUM('completed', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	-- Which pipeline produced this run: 'csv' today, a vendor key ('square',
	-- 'toast') when direct integrations land. Kept as text rather than an enum
	-- so adding an adapter needs no migration.
	"adapter" text DEFAULT 'csv' NOT NULL,
	"source" "sale_source" DEFAULT 'csv_import' NOT NULL,
	"status" "sales_import_status" DEFAULT 'completed' NOT NULL,
	"filename" text,
	"file_size" integer,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"imported_rows" integer DEFAULT 0 NOT NULL,
	"skipped_rows" integer DEFAULT 0 NOT NULL,
	"failed_rows" integer DEFAULT 0 NOT NULL,
	"duplicate_rows" integer DEFAULT 0 NOT NULL,
	"sale_count" integer DEFAULT 0 NOT NULL,
	"total_millis" integer DEFAULT 0 NOT NULL,
	"mapping" text,
	"issue_summary" text,
	"error_message" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sales_imports" ADD CONSTRAINT "sales_imports_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sales_imports" ADD CONSTRAINT "sales_imports_location_id_locations_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- The history screen lists newest first within one organization.
CREATE INDEX IF NOT EXISTS "sales_imports_org_idx" ON "sales_imports" ("organization_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_imports_org_location_idx" ON "sales_imports" ("organization_id", "location_id");

--> statement-breakpoint
-- Counts describe a finished run, so none of them can be negative, and the
-- parts cannot exceed the whole. Stated in the database because these are
-- computed in application code: a bug in the aggregation should fail the
-- transaction rather than persist a receipt that misreports what happened.
DO $$ BEGIN
  ALTER TABLE "sales_imports" ADD CONSTRAINT "sales_imports_counts_non_negative"
    CHECK ("total_rows" >= 0 AND "imported_rows" >= 0 AND "skipped_rows" >= 0
       AND "failed_rows" >= 0 AND "duplicate_rows" >= 0 AND "sale_count" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sales_imports" ADD CONSTRAINT "sales_imports_rows_add_up"
    CHECK ("imported_rows" + "skipped_rows" <= "total_rows");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- Ties a sale to the run that created it. Nullable, because manually entered
-- sales have no import.
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "import_id" uuid;

--> statement-breakpoint
-- SET NULL, not CASCADE: deleting an import receipt must never delete the
-- revenue it created. The sales survive, still marked `source = 'csv_import'`,
-- and simply lose the pointer back to the run.
DO $$ BEGIN
  ALTER TABLE "sales" ADD CONSTRAINT "sales_import_id_sales_imports_id_fk"
    FOREIGN KEY ("import_id") REFERENCES "public"."sales_imports"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- Serves the import detail screen ("show me the sales this run created").
-- Partial, since the vast majority of sales are not imported.
CREATE INDEX IF NOT EXISTS "sales_import_idx" ON "sales" ("import_id") WHERE "import_id" IS NOT NULL;
