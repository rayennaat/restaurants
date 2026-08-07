ALTER TABLE "ingredients" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD COLUMN "unit_code" text;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD COLUMN "base_quantity" numeric(18, 6);--> statement-breakpoint
ALTER TABLE "purchase_items" ADD COLUMN "base_unit_cost_millis" integer;--> statement-breakpoint
ALTER TABLE "purchase_items" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "unit_code" text;--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "yield_unit_code" text;--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD COLUMN "pack_unit_code" text;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD COLUMN "last_purchased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "suppliers" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "menu_items_recipe_idx" ON "menu_items" USING btree ("recipe_id");--> statement-breakpoint
CREATE INDEX "purchase_items_purchase_idx" ON "purchase_items" USING btree ("purchase_id");--> statement-breakpoint
CREATE INDEX "purchase_items_ingredient_idx" ON "purchase_items" USING btree ("ingredient_id");--> statement-breakpoint
CREATE INDEX "purchases_org_supplier_idx" ON "purchases" USING btree ("organization_id","supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recipes_org_name_uidx" ON "recipes" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "stock_movements_reference_idx" ON "stock_movements" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "supplier_products_ingredient_idx" ON "supplier_products" USING btree ("ingredient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_products_supplier_ingredient_uidx" ON "supplier_products" USING btree ("supplier_id","ingredient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppliers_org_name_uidx" ON "suppliers" USING btree ("organization_id","name");