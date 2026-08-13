import type { RecipeLineInput } from "@/lib/costing";

/**
 * Composition lines are stored twice in the schema — `recipe_ingredients` for
 * preparations and `menu_item_lines` for dishes — but both are read the same way:
 * left-join the ingredient and the component recipe, then split each row into
 * what the form renders and what the cost engine consumes. That mapping lives
 * here so the two query modules cannot drift apart.
 */

/** One editable line: either a raw ingredient or a preparation. */
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

/** The shape both line queries select, whichever table they read from. */
export type LineJoinRow = {
  id: string;
  ingredientId: string | null;
  componentRecipeId: string | null;
  ingredientName: string | null;
  ingredientBaseUnit: string | null;
  ingredientCostMillis: number | null;
  componentName: string | null;
  componentYieldUnit: string | null;
  quantity: string | number;
  unitCode: string | null;
  sortOrder: number;
};

/**
 * Splits one joined line row into its display and costing forms.
 *
 * Returns null for a line with neither target. The DB check constraint makes
 * that impossible, but the left joins leave both sides nullable to TypeScript.
 */
export function mapLineRow(row: LineJoinRow): { display: RecipeLineRow; graph: RecipeLineInput } | null {
  const quantity = Number(row.quantity);

  if (row.componentRecipeId) {
    const name = row.componentName ?? "Unknown preparation";
    return {
      display: {
        id: row.id,
        kind: "recipe",
        targetId: row.componentRecipeId,
        name,
        quantity,
        unitCode: row.unitCode,
        baseUnitCode: row.componentYieldUnit ?? "",
        sortOrder: row.sortOrder,
      },
      graph: { kind: "recipe", componentRecipeId: row.componentRecipeId, componentName: name, quantity, unitCode: row.unitCode },
    };
  }

  if (!row.ingredientId) return null;

  const name = row.ingredientName ?? "Unknown ingredient";
  const baseUnitCode = row.ingredientBaseUnit ?? "";
  return {
    display: { id: row.id, kind: "ingredient", targetId: row.ingredientId, name, quantity, unitCode: row.unitCode, baseUnitCode, sortOrder: row.sortOrder },
    graph: {
      kind: "ingredient",
      ingredientId: row.ingredientId,
      ingredientName: name,
      quantity,
      unitCode: row.unitCode,
      baseUnitCode,
      unitCostMillis: row.ingredientCostMillis ?? 0,
    },
  };
}

/** Appends to a keyed bucket, creating it on first use. */
export function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Human-readable makeup of a composition: "3 ingredients + 1 preparation". */
export function summarizeLines(lines: RecipeLineRow[]) {
  const preparations = lines.filter(line => line.kind === "recipe").length;
  const ingredients = lines.length - preparations;

  const parts: string[] = [];
  if (ingredients > 0) parts.push(`${ingredients} ingredient${ingredients === 1 ? "" : "s"}`);
  if (preparations > 0) parts.push(`${preparations} preparation${preparations === 1 ? "" : "s"}`);
  return parts.join(" + ");
}
