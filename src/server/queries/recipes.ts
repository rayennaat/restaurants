import { and, asc, eq, ilike, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, menuItems, recipeIngredients, recipes } from "@/db/schema";
import { calculateMenuEconomics, costRecipe, type MenuEconomics, type RecipeCosting } from "@/lib/costing";
import type { UnitRow } from "@/lib/units";

export type RecipeLineRow = {
  ingredientId: string;
  ingredientName: string;
  baseUnitCode: string;
  quantity: number;
  unitCode: string | null;
  unitCostMillis: number;
  sortOrder: number;
};

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
  /** Menu items selling this recipe, with their own economics. */
  menuItems: { id: string; name: string; sellingPriceMillis: number; packagingCostMillis: number; economics: MenuEconomics }[];
};

/**
 * Loads recipes with their lines and prices them against live ingredient costs.
 *
 * Costs are never stored: reading a recipe always recomputes from
 * `ingredients.latest_unit_cost_millis`, so a purchase that changes a price
 * instantly re-prices every recipe and menu item that uses that ingredient.
 */
export async function listRecipesWithCosting(organizationId: string, units: UnitRow[], filters: { q?: string; status?: "active" | "archived" | "all" } = {}): Promise<RecipeWithCosting[]> {
  const db = getDb();
  const conditions = [eq(recipes.organizationId, organizationId)];
  if (!filters.status || filters.status === "active") conditions.push(eq(recipes.isActive, true));
  else if (filters.status === "archived") conditions.push(eq(recipes.isActive, false));
  if (filters.q) conditions.push(ilike(recipes.name, `%${filters.q}%`));

  const recipeRows = await db
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
    .where(and(...conditions))
    .orderBy(asc(recipes.name));

  if (!recipeRows.length) return [];
  const recipeIds = recipeRows.map(row => row.id);

  const [lineRows, menuRows] = await Promise.all([
    db
      .select({
        recipeId: recipeIngredients.recipeId,
        ingredientId: recipeIngredients.ingredientId,
        ingredientName: ingredients.name,
        baseUnitCode: ingredients.baseUnitCode,
        quantity: recipeIngredients.quantity,
        unitCode: recipeIngredients.unitCode,
        unitCostMillis: ingredients.latestUnitCostMillis,
        sortOrder: recipeIngredients.sortOrder,
      })
      .from(recipeIngredients)
      .innerJoin(ingredients, eq(ingredients.id, recipeIngredients.ingredientId))
      .where(sql`${recipeIngredients.recipeId} in ${recipeIds}`)
      .orderBy(asc(recipeIngredients.sortOrder), asc(ingredients.name)),
    db
      .select({
        id: menuItems.id,
        recipeId: menuItems.recipeId,
        name: menuItems.name,
        sellingPriceMillis: menuItems.sellingPriceMillis,
        packagingCostMillis: menuItems.packagingCostMillis,
      })
      .from(menuItems)
      .where(and(eq(menuItems.organizationId, organizationId), eq(menuItems.isActive, true), sql`${menuItems.recipeId} in ${recipeIds}`)),
  ]);

  const linesByRecipe = new Map<string, RecipeLineRow[]>();
  for (const row of lineRows) {
    const line: RecipeLineRow = { ...row, quantity: Number(row.quantity) };
    const existing = linesByRecipe.get(row.recipeId);
    if (existing) existing.push(line);
    else linesByRecipe.set(row.recipeId, [line]);
  }

  return recipeRows.map(recipe => {
    const lines = linesByRecipe.get(recipe.id) ?? [];
    const yieldQuantity = Number(recipe.yieldQuantity);
    const costing = costRecipe(
      lines.map(line => ({
        ingredientId: line.ingredientId,
        ingredientName: line.ingredientName,
        quantity: line.quantity,
        unitCode: line.unitCode,
        baseUnitCode: line.baseUnitCode,
        unitCostMillis: line.unitCostMillis,
      })),
      yieldQuantity,
      units,
    );

    return {
      ...recipe,
      yieldQuantity,
      lines,
      costing,
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
            isCosted: lines.length > 0,
          }),
        })),
    };
  });
}

export async function getRecipeWithCosting(organizationId: string, id: string, units: UnitRow[]) {
  const all = await listRecipesWithCosting(organizationId, units, { status: "all" });
  return all.find(recipe => recipe.id === id) ?? null;
}

/** Recipe picker options for linking a menu item. */
export async function listRecipeOptions(organizationId: string) {
  return getDb()
    .select({ id: recipes.id, name: recipes.name, yieldQuantity: recipes.yieldQuantity })
    .from(recipes)
    .where(and(eq(recipes.organizationId, organizationId), eq(recipes.isActive, true)))
    .orderBy(asc(recipes.name));
}
