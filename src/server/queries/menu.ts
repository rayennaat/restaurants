import { and, asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { menuItems, recipes } from "@/db/schema";
import { calculateMenuEconomics, type MenuEconomics } from "@/lib/costing";
import type { UnitRow } from "@/lib/units";
import { listRecipesWithCosting } from "./recipes";

export type MenuItemRow = {
  id: string;
  name: string;
  category: string | null;
  recipeId: string | null;
  recipeName: string | null;
  sellingPriceMillis: number;
  packagingCostMillis: number;
  isActive: boolean;
  economics: MenuEconomics;
};

/**
 * Menu items priced against their linked recipe's live cost.
 *
 * Items without a recipe still appear — with `economics.isCosted === false` —
 * so the gap is visible rather than silently showing 100% margin.
 */
export async function listMenuItems(organizationId: string, units: UnitRow[], filters: { status?: "active" | "archived" | "all" } = {}): Promise<MenuItemRow[]> {
  const db = getDb();
  const conditions = [eq(menuItems.organizationId, organizationId)];
  if (!filters.status || filters.status === "active") conditions.push(eq(menuItems.isActive, true));
  else if (filters.status === "archived") conditions.push(eq(menuItems.isActive, false));

  const [rows, costedRecipes] = await Promise.all([
    db
      .select({
        id: menuItems.id,
        name: menuItems.name,
        category: menuItems.category,
        recipeId: menuItems.recipeId,
        recipeName: recipes.name,
        sellingPriceMillis: menuItems.sellingPriceMillis,
        packagingCostMillis: menuItems.packagingCostMillis,
        isActive: menuItems.isActive,
      })
      .from(menuItems)
      .leftJoin(recipes, eq(recipes.id, menuItems.recipeId))
      .where(and(...conditions))
      .orderBy(asc(menuItems.name)),
    listRecipesWithCosting(organizationId, units, { status: "all" }),
  ]);

  const costPerServing = new Map(costedRecipes.map(recipe => [recipe.id, recipe.costing.costPerServingMillis]));

  return rows.map(row => ({
    ...row,
    economics: calculateMenuEconomics({
      sellingPriceMillis: row.sellingPriceMillis,
      recipeCostMillis: row.recipeId ? (costPerServing.get(row.recipeId) ?? 0) : 0,
      packagingCostMillis: row.packagingCostMillis,
      isCosted: Boolean(row.recipeId),
    }),
  }));
}
