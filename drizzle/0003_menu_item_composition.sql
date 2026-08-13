-- Menu items own their composition; recipes become preparations only.
--
-- A dish used to exist twice: as a menu item, and as a hidden `recipes` row
-- written behind it. That phantom row forced the app to reason about whether a
-- recipe was "owned" by one menu item or shared, and to fork it on edit.
--
-- After this migration:
--   * every `recipes` row is a preparation (batched, consumed, never sold);
--   * every dish lives entirely in `menu_items` + `menu_item_lines`.
--
-- Existing data is copied onto the menu items before anything is dropped.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "menu_item_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"ingredient_id" uuid,
	"component_recipe_id" uuid,
	"quantity" numeric(18, 4) NOT NULL,
	"unit_code" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "menu_item_lines"
    ADD CONSTRAINT "menu_item_lines_menu_item_id_menu_items_id_fk"
    FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "menu_item_lines"
    ADD CONSTRAINT "menu_item_lines_ingredient_id_ingredients_id_fk"
    FOREIGN KEY ("ingredient_id") REFERENCES "ingredients"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "menu_item_lines"
    ADD CONSTRAINT "menu_item_lines_component_recipe_id_recipes_id_fk"
    FOREIGN KEY ("component_recipe_id") REFERENCES "recipes"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- Exactly one target per line: a raw ingredient or a preparation, never both or neither.
DO $$ BEGIN
  ALTER TABLE "menu_item_lines"
    ADD CONSTRAINT "menu_item_lines_single_target_chk"
    CHECK (num_nonnulls("ingredient_id", "component_recipe_id") = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_item_lines_menu_item_idx" ON "menu_item_lines" ("menu_item_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "menu_item_lines_component_idx" ON "menu_item_lines" ("component_recipe_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "menu_item_lines_item_ingredient_uidx" ON "menu_item_lines" ("menu_item_id", "ingredient_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "menu_item_lines_item_component_uidx" ON "menu_item_lines" ("menu_item_id", "component_recipe_id");

--> statement-breakpoint
-- Portions per batch used to live on the hidden recipe.
ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "yield_quantity" numeric(18, 3) DEFAULT '1' NOT NULL;

--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'menu_items' AND column_name = 'recipe_id') THEN

    -- 1. Carry the batch yield over from the recipe that backed each dish.
    UPDATE "menu_items" mi
      SET "yield_quantity" = r."yield_quantity"
      FROM "recipes" r
      WHERE r."id" = mi."recipe_id"
        AND r."is_preparation" = false
        AND r."yield_quantity" > 0;

    -- 2a. A dish recipe: copy its lines onto the menu item. Two menu items that
    --     shared one recipe each get their own copy, which is the point.
    INSERT INTO "menu_item_lines" ("menu_item_id", "ingredient_id", "component_recipe_id", "quantity", "unit_code", "sort_order")
      SELECT mi."id", ri."ingredient_id", ri."component_recipe_id", ri."quantity", ri."unit_code", ri."sort_order"
      FROM "menu_items" mi
      JOIN "recipes" r ON r."id" = mi."recipe_id" AND r."is_preparation" = false
      JOIN "recipe_ingredients" ri ON ri."recipe_id" = r."id"
      ON CONFLICT DO NOTHING;

    -- 2b. A menu item pointed straight at a preparation (possible in data that
    --     predates composed dishes). Keep the link as a single component line
    --     rather than flattening the preparation into its raw ingredients.
    INSERT INTO "menu_item_lines" ("menu_item_id", "ingredient_id", "component_recipe_id", "quantity", "unit_code", "sort_order")
      SELECT mi."id", NULL, r."id", 1, r."yield_unit_code", 0
      FROM "menu_items" mi
      JOIN "recipes" r ON r."id" = mi."recipe_id" AND r."is_preparation" = true
      ON CONFLICT DO NOTHING;

    -- 3. Defensive: a dish recipe that something still consumes becomes a
    --    preparation instead of being deleted below. Expected to match nothing.
    UPDATE "recipes"
      SET "is_preparation" = true
      WHERE "is_preparation" = false
        AND "id" IN (SELECT "component_recipe_id" FROM "recipe_ingredients" WHERE "component_recipe_id" IS NOT NULL);

    -- 4. The dish recipes have been copied and are referenced by nothing.
    DELETE FROM "recipes" WHERE "is_preparation" = false;

  END IF;
END $$;

--> statement-breakpoint
DROP INDEX IF EXISTS "menu_items_recipe_idx";
--> statement-breakpoint
ALTER TABLE "menu_items" DROP COLUMN IF EXISTS "recipe_id";
--> statement-breakpoint
ALTER TABLE "recipes" DROP COLUMN IF EXISTS "is_preparation";
