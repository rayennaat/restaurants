import { and, asc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { cache } from "react";
import { getDb } from "@/db/client";
import { ingredients, menuItemLines, menuItems, recipeIngredients, recipes } from "@/db/schema";
import { costRecipeGraph, type RecipeCosting, type RecipeGraphNode, type RecipeLineInput } from "@/lib/costing";
import type { UnitRow } from "@/lib/units";
import { mapLineRow, push, type RecipeLineRow } from "./recipe-lines";

export type { RecipeLineRow } from "./recipe-lines";

/** Something that consumes a preparation: another preparation, or a dish. */
export type PreparationConsumer = { id: string; name: string; kind: "recipe" | "menu_item" };

export type RecipeWithCosting = {
  id: string;
  name: string;
  yieldQuantity: number;
  yieldUnitCode: string | null;
  notes: string | null;
  isActive: boolean;
  updatedAt: Date;
  lines: RecipeLineRow[];
  costing: RecipeCosting;
  /** Preparations and menu items that consume this one. */
  usedIn: PreparationConsumer[];
};

type RecipeFilters = { q?: string; status?: "active" | "archived" | "all" };

/**
 * Every preparation in the org with its lines, in both shapes: the display rows
 * a form renders and the costing inputs the engine consumes.
 *
 * The whole graph is always loaded, never a filtered slice, because a displayed
 * preparation may depend on one a filter would exclude. Cached per request so a
 * page that lists preparations *and* prices menu items pays for it once.
 */
const loadPreparations = cache(async (organizationId: string) => {
  const db = getDb();
  const componentRecipes = alias(recipes, "component_recipes");

  const [recipeRows, lineRows] = await Promise.all([
    db
      .select({
        id: recipes.id,
        name: recipes.name,
        yieldQuantity: recipes.yieldQuantity,
        yieldUnitCode: recipes.yieldUnitCode,
        notes: recipes.notes,
        isActive: recipes.isActive,
        updatedAt: recipes.updatedAt,
      })
      .from(recipes)
      .where(eq(recipes.organizationId, organizationId))
      .orderBy(asc(recipes.name)),
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
      .innerJoin(recipes, eq(recipes.id, recipeIngredients.recipeId))
      .leftJoin(ingredients, eq(ingredients.id, recipeIngredients.ingredientId))
      .leftJoin(componentRecipes, eq(componentRecipes.id, recipeIngredients.componentRecipeId))
      .where(eq(recipes.organizationId, organizationId))
      .orderBy(asc(recipeIngredients.sortOrder)),
  ]);

  const displayLines = new Map<string, RecipeLineRow[]>();
  const graphLines = new Map<string, RecipeLineInput[]>();
  const usedIn = new Map<string, PreparationConsumer[]>();
  const nameById = new Map(recipeRows.map(row => [row.id, row.name]));

  for (const row of lineRows) {
    const mapped = mapLineRow(row);
    if (!mapped) continue;
    push(displayLines, row.recipeId, mapped.display);
    push(graphLines, row.recipeId, mapped.graph);
    if (row.componentRecipeId) push(usedIn, row.componentRecipeId, { id: row.recipeId, name: nameById.get(row.recipeId) ?? "", kind: "recipe" });
  }

  const nodes: RecipeGraphNode[] = recipeRows.map(row => ({
    id: row.id,
    name: row.name,
    yieldQuantity: Number(row.yieldQuantity),
    yieldUnitCode: row.yieldUnitCode,
    lines: graphLines.get(row.id) ?? [],
  }));

  return { recipeRows, displayLines, usedIn, nodes };
});

/** The preparation graph as the cost engine wants it, for pricing dishes. */
export async function getPreparationGraph(organizationId: string): Promise<RecipeGraphNode[]> {
  return (await loadPreparations(organizationId)).nodes;
}

/**
 * Preparations priced against live ingredient costs.
 *
 * Costs are never stored: reading always recomputes from
 * `ingredients.latest_unit_cost_millis`, so a purchase that changes a price
 * instantly re-prices every preparation and every dish above it.
 */
export async function listRecipesWithCosting(organizationId: string, units: UnitRow[], filters: RecipeFilters = {}): Promise<RecipeWithCosting[]> {
  const { recipeRows, displayLines, usedIn, nodes } = await loadPreparations(organizationId);
  if (!recipeRows.length) return [];

  // Dishes consuming a preparation, so its card can say where it is used.
  const dishUsageRows = await getDb()
    .select({ componentRecipeId: menuItemLines.componentRecipeId, menuItemId: menuItems.id, menuItemName: menuItems.name })
    .from(menuItemLines)
    .innerJoin(menuItems, eq(menuItems.id, menuItemLines.menuItemId))
    .where(and(eq(menuItems.organizationId, organizationId), inArray(menuItemLines.componentRecipeId, recipeRows.map(row => row.id))));

  const consumers = new Map(usedIn);
  for (const row of dishUsageRows) {
    if (!row.componentRecipeId) continue;
    // Copy on write so the cached map from loadPreparations is never mutated.
    consumers.set(row.componentRecipeId, [...(consumers.get(row.componentRecipeId) ?? []), { id: row.menuItemId, name: row.menuItemName, kind: "menu_item" }]);
  }

  const costings = costRecipeGraph(nodes, units);
  const search = filters.q?.trim().toLowerCase();
  const status = filters.status ?? "active";

  return recipeRows
    .filter(recipe => {
      if (status === "active" && !recipe.isActive) return false;
      if (status === "archived" && recipe.isActive) return false;
      if (search && !recipe.name.toLowerCase().includes(search)) return false;
      return true;
    })
    .map(recipe => ({
      ...recipe,
      yieldQuantity: Number(recipe.yieldQuantity),
      lines: displayLines.get(recipe.id) ?? [],
      costing: costings.get(recipe.id)!,
      usedIn: consumers.get(recipe.id) ?? [],
    }));
}

export async function getRecipeWithCosting(organizationId: string, id: string, units: UnitRow[]) {
  const all = await listRecipesWithCosting(organizationId, units, { status: "all" });
  return all.find(recipe => recipe.id === id) ?? null;
}

/** Preparation picker options, for a sub-preparation line or a dish line. */
export async function listRecipeOptions(organizationId: string) {
  return getDb()
    .select({ id: recipes.id, name: recipes.name, yieldQuantity: recipes.yieldQuantity, yieldUnitCode: recipes.yieldUnitCode })
    .from(recipes)
    .where(and(eq(recipes.organizationId, organizationId), eq(recipes.isActive, true)))
    .orderBy(asc(recipes.name));
}

export type RecipeOption = Awaited<ReturnType<typeof listRecipeOptions>>[number];
