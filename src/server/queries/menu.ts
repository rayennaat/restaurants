import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, menuItemLines, menuItems, recipes } from "@/db/schema";
import { calculateMenuEconomics, costMenuItems, type MenuEconomics, type MenuGraphNode, type RecipeCosting, type RecipeLineInput } from "@/lib/costing";
import type { UnitRow } from "@/lib/units";
import { mapLineRow, push, type RecipeLineRow } from "./recipe-lines";
import { getPreparationGraph } from "./recipes";

export type MenuItemRow = {
  id: string;
  name: string;
  category: string | null;
  /** Portions one batch of `lines` yields. */
  yieldQuantity: number;
  sellingPriceMillis: number;
  packagingCostMillis: number;
  isActive: boolean;
  /** This dish's own composition — ingredients and preparations. */
  lines: RecipeLineRow[];
  costing: RecipeCosting;
  economics: MenuEconomics;
};

/**
 * Menu items priced from their own lines against live ingredient costs.
 *
 * A dish owns its composition outright, so nothing here is shared with another
 * item. Preparation lines resolve through the preparation graph, which is what
 * lets a change in oil price reach a burger by way of the mayonnaise.
 *
 * Items with no lines yet still appear — with `economics.isCosted === false` —
 * so the gap is visible rather than silently showing 100% margin.
 */
export async function listMenuItems(organizationId: string, units: UnitRow[], filters: { status?: "active" | "archived" | "all" } = {}): Promise<MenuItemRow[]> {
  const db = getDb();
  const conditions = [eq(menuItems.organizationId, organizationId)];
  if (!filters.status || filters.status === "active") conditions.push(eq(menuItems.isActive, true));
  else if (filters.status === "archived") conditions.push(eq(menuItems.isActive, false));

  const rows = await db
    .select({
      id: menuItems.id,
      name: menuItems.name,
      category: menuItems.category,
      yieldQuantity: menuItems.yieldQuantity,
      sellingPriceMillis: menuItems.sellingPriceMillis,
      packagingCostMillis: menuItems.packagingCostMillis,
      isActive: menuItems.isActive,
    })
    .from(menuItems)
    .where(and(...conditions))
    .orderBy(asc(menuItems.name));

  if (!rows.length) return [];

  const [lineRows, preparations] = await Promise.all([
    db
      .select({
        id: menuItemLines.id,
        menuItemId: menuItemLines.menuItemId,
        ingredientId: menuItemLines.ingredientId,
        componentRecipeId: menuItemLines.componentRecipeId,
        ingredientName: ingredients.name,
        ingredientBaseUnit: ingredients.baseUnitCode,
        ingredientCostMillis: ingredients.latestUnitCostMillis,
        componentName: recipes.name,
        componentYieldUnit: recipes.yieldUnitCode,
        quantity: menuItemLines.quantity,
        unitCode: menuItemLines.unitCode,
        sortOrder: menuItemLines.sortOrder,
      })
      .from(menuItemLines)
      .leftJoin(ingredients, eq(ingredients.id, menuItemLines.ingredientId))
      .leftJoin(recipes, eq(recipes.id, menuItemLines.componentRecipeId))
      .where(inArray(menuItemLines.menuItemId, rows.map(row => row.id)))
      .orderBy(asc(menuItemLines.sortOrder)),
    getPreparationGraph(organizationId),
  ]);

  const displayLines = new Map<string, RecipeLineRow[]>();
  const graphLines = new Map<string, RecipeLineInput[]>();

  for (const row of lineRows) {
    const mapped = mapLineRow(row);
    if (!mapped) continue;
    push(displayLines, row.menuItemId, mapped.display);
    push(graphLines, row.menuItemId, mapped.graph);
  }

  const nodes: MenuGraphNode[] = rows.map(row => ({
    id: row.id,
    name: row.name,
    yieldQuantity: Number(row.yieldQuantity),
    lines: graphLines.get(row.id) ?? [],
  }));
  const costings = costMenuItems(nodes, preparations, units);

  return rows.map(row => {
    const lines = displayLines.get(row.id) ?? [];
    const costing = costings.get(row.id)!;

    return {
      ...row,
      yieldQuantity: Number(row.yieldQuantity),
      lines,
      costing,
      economics: calculateMenuEconomics({
        sellingPriceMillis: row.sellingPriceMillis,
        recipeCostMillis: costing.costPerServingMillis,
        packagingCostMillis: row.packagingCostMillis,
        isCosted: lines.length > 0 && !costing.circularPath.length,
      }),
    };
  });
}
