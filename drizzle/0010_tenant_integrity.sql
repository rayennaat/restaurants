-- Tenant and financial integrity defense in depth.
--
-- The application resolves every foreign id inside the authenticated tenant, but
-- the server connects through a privileged role that bypasses RLS. Ordinary
-- single-column foreign keys only prove that a referenced row exists; they do
-- not prove it belongs to the same organization. These composite foreign keys
-- and child-row triggers make that invariant hold even if a future server path,
-- migration, or operator command omits an application check.
--
-- Existing data is deliberately not rewritten. Adding these constraints scans
-- current rows and aborts the migration if a cross-tenant reference already
-- exists, preserving evidence instead of silently guessing how to repair it.

--> statement-breakpoint
-- Composite foreign keys need a unique key containing both identity and tenant.
-- The UUID primary keys remain the canonical identity; these indexes exist only
-- to support same-organization references.
CREATE UNIQUE INDEX IF NOT EXISTS "locations_id_org_uidx" ON public.locations ("id", "organization_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ingredients_id_org_uidx" ON public.ingredients ("id", "organization_id");
CREATE UNIQUE INDEX IF NOT EXISTS "suppliers_id_org_uidx" ON public.suppliers ("id", "organization_id");
CREATE UNIQUE INDEX IF NOT EXISTS "recipes_id_org_uidx" ON public.recipes ("id", "organization_id");
CREATE UNIQUE INDEX IF NOT EXISTS "menu_items_id_org_uidx" ON public.menu_items ("id", "organization_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_imports_id_org_uidx" ON public.sales_imports ("id", "organization_id");

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.organization_members
    ADD CONSTRAINT "organization_members_location_same_org_fk"
    FOREIGN KEY ("default_location_id", "organization_id")
    REFERENCES public.locations ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.organization_invitations
    ADD CONSTRAINT "organization_invitations_location_same_org_fk"
    FOREIGN KEY ("default_location_id", "organization_id")
    REFERENCES public.locations ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.supplier_products
    ADD CONSTRAINT "supplier_products_supplier_same_org_fk"
    FOREIGN KEY ("supplier_id", "organization_id")
    REFERENCES public.suppliers ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.supplier_products
    ADD CONSTRAINT "supplier_products_ingredient_same_org_fk"
    FOREIGN KEY ("ingredient_id", "organization_id")
    REFERENCES public.ingredients ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.purchases
    ADD CONSTRAINT "purchases_location_same_org_fk"
    FOREIGN KEY ("location_id", "organization_id")
    REFERENCES public.locations ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.purchases
    ADD CONSTRAINT "purchases_supplier_same_org_fk"
    FOREIGN KEY ("supplier_id", "organization_id")
    REFERENCES public.suppliers ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.stock_movements
    ADD CONSTRAINT "stock_movements_location_same_org_fk"
    FOREIGN KEY ("location_id", "organization_id")
    REFERENCES public.locations ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.stock_movements
    ADD CONSTRAINT "stock_movements_ingredient_same_org_fk"
    FOREIGN KEY ("ingredient_id", "organization_id")
    REFERENCES public.ingredients ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.waste_entries
    ADD CONSTRAINT "waste_entries_location_same_org_fk"
    FOREIGN KEY ("location_id", "organization_id")
    REFERENCES public.locations ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.waste_entries
    ADD CONSTRAINT "waste_entries_ingredient_same_org_fk"
    FOREIGN KEY ("ingredient_id", "organization_id")
    REFERENCES public.ingredients ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.sales
    ADD CONSTRAINT "sales_location_same_org_fk"
    FOREIGN KEY ("location_id", "organization_id")
    REFERENCES public.locations ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.sales
    ADD CONSTRAINT "sales_import_same_org_fk"
    FOREIGN KEY ("import_id", "organization_id")
    REFERENCES public.sales_imports ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.sales_imports
    ADD CONSTRAINT "sales_imports_location_same_org_fk"
    FOREIGN KEY ("location_id", "organization_id")
    REFERENCES public.locations ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.stock_counts
    ADD CONSTRAINT "stock_counts_location_same_org_fk"
    FOREIGN KEY ("location_id", "organization_id")
    REFERENCES public.locations ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.stock_transfers
    ADD CONSTRAINT "stock_transfers_source_same_org_fk"
    FOREIGN KEY ("source_location_id", "organization_id")
    REFERENCES public.locations ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE public.stock_transfers
    ADD CONSTRAINT "stock_transfers_destination_same_org_fk"
    FOREIGN KEY ("destination_location_id", "organization_id")
    REFERENCES public.locations ("id", "organization_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- Child tables have no organization_id of their own. Each trigger compares the
-- tenant inherited from the owning document with the tenant of every referenced
-- catalog row before the write can land.
CREATE OR REPLACE FUNCTION public.purchase_items_same_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE owner_org uuid; target_org uuid;
BEGIN
  SELECT organization_id INTO owner_org FROM purchases WHERE id = NEW.purchase_id;
  SELECT organization_id INTO target_org FROM ingredients WHERE id = NEW.ingredient_id;
  IF owner_org IS DISTINCT FROM target_org THEN
    RAISE EXCEPTION 'purchase item references an ingredient from another organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS purchase_items_same_org_trg ON public.purchase_items;
CREATE TRIGGER purchase_items_same_org_trg
  BEFORE INSERT OR UPDATE ON public.purchase_items
  FOR EACH ROW EXECUTE FUNCTION public.purchase_items_same_org();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.recipe_ingredients_same_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE owner_org uuid; target_org uuid;
BEGIN
  SELECT organization_id INTO owner_org FROM recipes WHERE id = NEW.recipe_id;
  IF NEW.ingredient_id IS NOT NULL THEN
    SELECT organization_id INTO target_org FROM ingredients WHERE id = NEW.ingredient_id;
  ELSE
    SELECT organization_id INTO target_org FROM recipes WHERE id = NEW.component_recipe_id;
  END IF;
  IF owner_org IS DISTINCT FROM target_org THEN
    RAISE EXCEPTION 'recipe line references a component from another organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS recipe_ingredients_same_org_trg ON public.recipe_ingredients;
CREATE TRIGGER recipe_ingredients_same_org_trg
  BEFORE INSERT OR UPDATE ON public.recipe_ingredients
  FOR EACH ROW EXECUTE FUNCTION public.recipe_ingredients_same_org();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.menu_item_lines_same_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE owner_org uuid; target_org uuid;
BEGIN
  SELECT organization_id INTO owner_org FROM menu_items WHERE id = NEW.menu_item_id;
  IF NEW.ingredient_id IS NOT NULL THEN
    SELECT organization_id INTO target_org FROM ingredients WHERE id = NEW.ingredient_id;
  ELSE
    SELECT organization_id INTO target_org FROM recipes WHERE id = NEW.component_recipe_id;
  END IF;
  IF owner_org IS DISTINCT FROM target_org THEN
    RAISE EXCEPTION 'menu item line references a component from another organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS menu_item_lines_same_org_trg ON public.menu_item_lines;
CREATE TRIGGER menu_item_lines_same_org_trg
  BEFORE INSERT OR UPDATE ON public.menu_item_lines
  FOR EACH ROW EXECUTE FUNCTION public.menu_item_lines_same_org();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.sale_lines_same_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE owner_org uuid; target_org uuid;
BEGIN
  SELECT organization_id INTO owner_org FROM sales WHERE id = NEW.sale_id;
  SELECT organization_id INTO target_org FROM menu_items WHERE id = NEW.menu_item_id;
  IF owner_org IS DISTINCT FROM target_org THEN
    RAISE EXCEPTION 'sale line references a menu item from another organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sale_lines_same_org_trg ON public.sale_lines;
CREATE TRIGGER sale_lines_same_org_trg
  BEFORE INSERT OR UPDATE ON public.sale_lines
  FOR EACH ROW EXECUTE FUNCTION public.sale_lines_same_org();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.stock_count_items_same_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE owner_org uuid; target_org uuid;
BEGIN
  SELECT organization_id INTO owner_org FROM stock_counts WHERE id = NEW.stock_count_id;
  SELECT organization_id INTO target_org FROM ingredients WHERE id = NEW.ingredient_id;
  IF owner_org IS DISTINCT FROM target_org THEN
    RAISE EXCEPTION 'stock count line references an ingredient from another organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS stock_count_items_same_org_trg ON public.stock_count_items;
CREATE TRIGGER stock_count_items_same_org_trg
  BEFORE INSERT OR UPDATE ON public.stock_count_items
  FOR EACH ROW EXECUTE FUNCTION public.stock_count_items_same_org();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.stock_transfer_items_same_org()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE owner_org uuid; target_org uuid;
BEGIN
  SELECT organization_id INTO owner_org FROM stock_transfers WHERE id = NEW.transfer_id;
  SELECT organization_id INTO target_org FROM ingredients WHERE id = NEW.ingredient_id;
  IF owner_org IS DISTINCT FROM target_org THEN
    RAISE EXCEPTION 'stock transfer line references an ingredient from another organization'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS stock_transfer_items_same_org_trg ON public.stock_transfer_items;
CREATE TRIGGER stock_transfer_items_same_org_trg
  BEFORE INSERT OR UPDATE ON public.stock_transfer_items
  FOR EACH ROW EXECUTE FUNCTION public.stock_transfer_items_same_org();

--> statement-breakpoint
-- Scalar financial and quantity constraints. Cross-row rollups remain guarded by
-- server-side transactions; these checks reject impossible values even through a
-- privileged direct connection.
DO $$ BEGIN
  ALTER TABLE public.ingredients ADD CONSTRAINT "ingredients_values_non_negative_chk"
    CHECK ("minimum_stock" >= 0 AND "latest_unit_cost_millis" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.units ADD CONSTRAINT "units_multiplier_positive_chk"
    CHECK ("multiplier_to_base" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.supplier_products ADD CONSTRAINT "supplier_products_values_non_negative_chk"
    CHECK ("pack_quantity" > 0 AND "last_price_millis" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.purchases ADD CONSTRAINT "purchases_total_non_negative_chk"
    CHECK ("total_millis" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.purchase_items ADD CONSTRAINT "purchase_items_values_valid_chk"
    CHECK ("quantity" > 0 AND "unit_cost_millis" >= 0 AND "line_total_millis" >= 0
      AND ("base_quantity" IS NULL OR "base_quantity" > 0)
      AND ("base_unit_cost_millis" IS NULL OR "base_unit_cost_millis" >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.stock_movements ADD CONSTRAINT "stock_movements_cost_non_negative_chk"
    CHECK ("unit_cost_millis" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.waste_entries ADD CONSTRAINT "waste_entries_values_valid_chk"
    CHECK ("quantity" > 0 AND "estimated_cost_millis" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.recipes ADD CONSTRAINT "recipes_yield_positive_chk"
    CHECK ("yield_quantity" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.recipe_ingredients ADD CONSTRAINT "recipe_ingredients_quantity_positive_chk"
    CHECK ("quantity" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.menu_items ADD CONSTRAINT "menu_items_values_valid_chk"
    CHECK ("yield_quantity" > 0 AND "selling_price_millis" >= 0 AND "packaging_cost_millis" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.menu_item_lines ADD CONSTRAINT "menu_item_lines_quantity_positive_chk"
    CHECK ("quantity" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.sales ADD CONSTRAINT "sales_total_non_negative_chk"
    CHECK ("total_millis" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.sale_lines ADD CONSTRAINT "sale_lines_total_consistent_chk"
    CHECK ("line_total_millis" = round("quantity" * "unit_price_millis"));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.sales_imports ADD CONSTRAINT "sales_imports_values_non_negative_chk"
    CHECK (("file_size" IS NULL OR "file_size" >= 0) AND "total_millis" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.stock_count_items ADD CONSTRAINT "stock_count_items_cost_non_negative_chk"
    CHECK ("unit_cost_millis" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE public.stock_transfer_items ADD CONSTRAINT "stock_transfer_items_values_valid_chk"
    CHECK ("base_quantity" > 0 AND "unit_cost_millis" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
