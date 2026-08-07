import { and, asc, eq, ilike, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "@/db/client";
import { ingredients, menuItems, recipeIngredients, recipes } from "@/db/schema";
import { calculateMenuEconomics, costRecipeGraph, type MenuEconomics, type RecipeCosting, type RecipeGraphNode, type RecipeLineInput } from "@/lib/costing";
import type { UnitRow } from "@/lib/units";

/** One editable line of a recipe: either a raw ingredient or a sub-recipe. */
export type RecipeLineRow = {
  id: string;
  kind: "ingredient" | "recipe";
  /** Ingredient id, or component recipe id when `kind` is "recipe". */
  targetId: string;
  name: string;
  quantity: number;
  unitCode: string | null;
  /** Ingredient base unit, or the component recipe's yield unit. */
  baseUnitCode: string;
  sortOrder: number;
};

export type RecipeWithCosting = {
  id: string;
  name: string;
  yieldQuantity: number;
  yieldUnitCode: string | null;
  /** Preparations are produced in batches and consumed by other recipes. */
  isPreparation: boolean;
  notes: string | null;
  isActive: boolean;
  updatedAt: Date;
  lines: RecipeLineRow[];
  costing: RecipeCosting;
  /** Menu items selling this recipe, with their own economics. */
  menuItems: { id: string; name: string; sellingPriceMillis: number; packagingCostMillis: number; economics: MenuEconomics }[];
  /** Recipes that consume this one as a preparation. */
  usedIn: { id: string; name: string }[];
};

type RecipeFilters = { q?: string; status?: "active" | "archived" | "all"; kind?: "all" | "dish" | "preparation" };

/**
 * Loads recipes with their lines and prices them against live ingredient costs.
 *
 * Costs are never stored: reading a recipe always recomputes from
 * `ingredients.latest_unit_cost_millis`, so a purchase that changes a price
 * instantly re-prices every recipe and menu item that uses that ingredient.
 *
 * The whole organization's recipe graph is always loaded, even when filters
 * narrow the returned list, because a displayed dish may depend on a
 * preparation that the filter excludes.
 */
export async function listRecipesWithCosting(organizationId: string, units: UnitRow[], filters: RecipeFilters = {}): Promise<RecipeWithCosting[]> {
  const db = getDb();
  const componentRecipes = alias(recipes, "component_recipes");

  const recipeRows = await db
    .select({
      id: recipes.id,
      name: recipes.name,
      yieldQuantity: recipes.yieldQuantity,
      yieldUnitCode: recipes.yieldUnitCode,
      isPreparation: recipes.isPreparation,
      notes: recipes.notes,
      isActive: recipes.isActive,
      updatedAt: recipes.updatedAt,
    })
    .from(recipes)
    .where(eq(recipes.organizationId, organizationId))
    .orderBy(asc(recipes.name));

  if (!recipeRows.length) return [];
  const allIds = recipeRows.map(row => row.id);

  const [lineRows, menuRows] = await Promise.all([
    db
      .select({
        id: recipeIngredients.id,
        recipeId: recipeIngredients.recipeId,
        ingredientId: recipeIngredients.ingredientId,
        componentRecipeId: recipeIngredients.componentRecipeId,
        ingredientName: ingredients.name,
        ingredientBaseUnit: ingredients.baseUnitCode,
        ingredientCostMillis: ingredients.latestUnitCostMillis,
        componentName: componentRecipes.name,
        componentYieldUnit: componentRecipes.yieldUnitCode,
        quantity: recipeIngredients.quantity,
        unitCode: recipeIngredients.unitCode,
        sortOrder: recipeIngredients.sortOrder,
      })
      .from(recipeIngredients)
      .leftJoin(ingredients, eq(ingredients.id, recipeIngredients.ingredientId))
      .leftJoin(componentRecipes, eq(componentRecipes.id, recipeIngredients.componentRecipeId))
      .where(inArray(recipeIngredients.recipeId, allIds))
      .orderBy(asc(recipeIngredients.sortOrder)),
    db
      .select({
        id: menuItems.id,
        recipeId: menuItems.recipeId,
        name: menuItems.name,
        sellingPriceMillis: menuItems.sellingPriceMillis,
        packagingCostMillis: menuItems.packagingCostMillis,
      })
      .from(menuItems)
      .where(and(eq(menuItems.organizationId, organizationId), eq(menuItems.isActive, true), inArray(menuItems.recipeId, allIds))),
  ]);

  const displayLines = new Map<string, RecipeLineRow[]>();
  const graphLines = new Map<string, RecipeLineInput[]>();
  const usedIn = new Map<string, { id: string; name: string }[]>();
  const nameById = new Map(recipeRows.map(row => [row.id, row.name]));

  for (const row of lineRows) {
    const quantity = Number(row.quantity);

    if (row.componentRecipeId) {
      const name = row.componentName ?? "Unknown preparation";
      push(displayLines, row.recipeId, {
        id: row.id,
        kind: "recipe",
        targetId: row.componentRecipeId,
        name,
        quantity,
        unitCode: row.unitCode,
        baseUnitCode: row.componentYieldUnit ?? "",
        sortOrder: row.sortOrder,
      });
      push(graphLines, row.recipeId, { kind: "recipe", componentRecipeId: row.componentRecipeId, componentName: name, quantity, unitCode: row.unitCode });
      push(usedIn, row.componentRecipeId, { id: row.recipeId, name: nameById.get(row.recipeId) ?? "" });
      continue;
    }

    // A line with neither target is impossible (DB check constraint), but the
    // left join makes both sides nullable to TypeScript.
    if (!row.ingredientId) continue;
    const name = row.ingredientName ?? "Unknown ingredient";
    const baseUnitCode = row.ingredientBaseUnit ?? "";
    push(displayLines, row.recipeId, { id: row.id, kind: "ingredient", targetId: row.ingredientId, name, quantity, unitCode: row.unitCode, baseUnitCode, sortOrder: row.sortOrder });
    push(graphLines, row.recipeId, {
      kind: "ingredient",
      ingredientId: row.ingredientId,
      ingredientName: name,
      quantity,
      unitCode: row.unitCode,
      baseUnitCode,
      unitCostMillis: row.ingredientCostMillis ?? 0,
    });
  }

  const graph: RecipeGraphNode[] = recipeRows.map(row => ({
    id: row.id,
    name: row.name,
    yieldQuantity: Number(row.yieldQuantity),
    yieldUnitCode: row.yieldUnitCode,
    lines: graphLines.get(row.id) ?? [],
  }));
  const costings = costRecipeGraph(graph, units);

  const search = filters.q?.trim().toLowerCase();
  const status = filters.status ?? "active";
  const kind = filters.kind ?? "all";

  return recipeRows
    .filter(recipe => {
      if (status === "active" && !recipe.isActive) return false;
      if (status === "archived" && recipe.isActive) return false;
      if (kind === "dish" && recipe.isPreparation) return false;
      if (kind === "preparation" && !recipe.isPreparation) return false;
      if (search && !recipe.name.toLowerCase().includes(search)) return false;
      return true;
    })
    .map(recipe => {
      const lines = displayLines.get(recipe.id) ?? [];
      const costing = costings.get(recipe.id)!;

      return {
        ...recipe,
        yieldQuantity: Number(recipe.yieldQuantity),
        lines,
        costing,
        usedIn: usedIn.get(recipe.id) ?? [],
        menuItems: menuRows
          .filter(item => item.recipeId === recipe.id)
          .map(item => ({
            id: item.id,
            name: item.name,
            sellingPriceMillis: item.sellingPriceMillis,
            packagingCostMillis: item.packagingCostMillis,
            economics: calculateMenuEconomics({
              sellingPriceMillis: item.sellingPriceMillis,
              recipeCostMillis: costing.costPerServingMillis,
              packagingCostMillis: item.packagingCostMillis,
              isCosted: lines.length > 0 && !costing.circularPath.length,
            }),
          })),
      };
    });
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

export async function getRecipeWithCosting(organizationId: string, id: string, units: UnitRow[]) {
  const all = await listRecipesWithCosting(organizationId, units, { status: "all", kind: "all" });
  return all.find(recipe => recipe.id === id) ?? null;
}

/** Recipe picker options for linking a menu item, or for choosing a sub-recipe. */
export async function listRecipeOptions(organizationId: string) {
  return getDb()
    .select({ id: recipes.id, name: recipes.name, yieldQuantity: recipes.yieldQuantity, yieldUnitCode: recipes.yieldUnitCode, isPreparation: recipes.isPreparation })
    .from(recipes)
    .where(and(eq(recipes.organizationId, organizationId), eq(recipes.isActive, true)))
    .orderBy(asc(recipes.name));
}

export type RecipeOption = Awaited<ReturnType<typeof listRecipeOptions>>[number];
