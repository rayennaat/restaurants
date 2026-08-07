-- Sub-recipes: a recipe line may target a raw ingredient OR another recipe.
--
-- This lets preparations (mayonnaise, ketchup, stocks, doughs) be costed once
-- from their own ingredients and then consumed by dishes by quantity, so an
-- ingredient price change propagates through every recipe that depends on it.
--
-- Existing rows are preserved: the old composite primary key is replaced by a
-- surrogate id, and ingredient_id becomes nullable.

--> statement-breakpoint
ALTER TABLE "recipes" ADD COLUMN IF NOT EXISTS "is_preparation" boolean DEFAULT false NOT NULL;

--> statement-breakpoint
ALTER TABLE "recipe_ingredients" DROP CONSTRAINT IF EXISTS "recipe_ingredients_recipe_id_ingredient_id_pk";

--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid() NOT NULL;

--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'recipe_ingredients'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE "recipe_ingredients" ADD PRIMARY KEY ("id");
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ALTER COLUMN "ingredient_id" DROP NOT NULL;

--> statement-breakpoint
ALTER TABLE "recipe_ingredients" ADD COLUMN IF NOT EXISTS "component_recipe_id" uuid;

--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "recipe_ingredients"
    ADD CONSTRAINT "recipe_ingredients_component_recipe_id_recipes_id_fk"
    FOREIGN KEY ("component_recipe_id") REFERENCES "recipes"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- Exactly one target per line: a raw ingredient or a sub-recipe, never both or neither.
DO $$ BEGIN
  ALTER TABLE "recipe_ingredients"
    ADD CONSTRAINT "recipe_ingredients_single_target_chk"
    CHECK (num_nonnulls("ingredient_id", "component_recipe_id") = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
-- A recipe can never consume itself directly. Deeper cycles are caught in the
-- application layer, which can report the offending path.
DO $$ BEGIN
  ALTER TABLE "recipe_ingredients"
    ADD CONSTRAINT "recipe_ingredients_no_self_reference_chk"
    CHECK ("component_recipe_id" IS NULL OR "component_recipe_id" <> "recipe_id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipe_ingredients_recipe_idx" ON "recipe_ingredients" ("recipe_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recipe_ingredients_component_idx" ON "recipe_ingredients" ("component_recipe_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recipe_ingredients_recipe_ingredient_uidx" ON "recipe_ingredients" ("recipe_id", "ingredient_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recipe_ingredients_recipe_component_uidx" ON "recipe_ingredients" ("recipe_id", "component_recipe_id");
