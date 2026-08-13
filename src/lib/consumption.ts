import type { RecipeGraphNode, MenuGraphNode } from "@/lib/costing";
import { toBaseQuantity, type UnitRow } from "@/lib/units";

/**
 * Theoretical ingredient consumption: what the kitchen *should* have used,
 * given what was sold.
 *
 * Sell 10 hamburgers at 150 g beef, 50 g cucumber and 1 bun each, and this
 * reports 1.5 kg beef, 0.5 kg cucumber and 10 buns. Compared against a stock
 * count, the gap is the variance worth investigating — over-portioning, waste
 * that went unrecorded, or theft.
 *
 * ## This module still computes; the caller decides whether to post
 *
 * Nothing here writes to `stock_movements` — these remain pure functions over
 * loaded rows. What changed is what the *caller* does with the result: recording
 * a sale now posts the expansion below as `sale_consumption` movements, so a
 * dish leaving the kitchen depletes its ingredients (see `server/actions/sales`).
 *
 * An earlier version of this comment argued that posting would destroy variance
 * by "comparing a figure against itself". That reasoning does not hold, and it
 * is worth stating why, because it looks convincing:
 *
 * Variance is `counted − system`, where `counted` is a number a human types
 * after physically counting a shelf. It is not derived from the ledger, so the
 * two sides stay independent no matter what the ledger contains. Posting
 * consumption changes what the *system* side means — from "everything we bought,
 * minus waste" to "what we should still be holding" — and that is precisely the
 * figure a count should be compared against. Without it, on-hand stock only ever
 * rises, and the entire expected usage of every sale surfaces as variance,
 * drowning the real signal it exists to isolate.
 *
 * What remains true is the distinction the ledger must preserve: a
 * `sale_consumption` movement is an *inference* from a recipe, while `purchase`,
 * `waste` and `stock_count_adjustment` are observations. The movement type is
 * what keeps them separable, so any report that needs measured-only movement can
 * still filter for it.
 *
 * ## Why it walks the graph rather than reading recipe_ingredients
 *
 * A dish's ingredients are not a flat list. A burger holds a bun, a patty, and
 * a sauce that is itself a preparation with its own ingredients. Only the graph
 * walk in {@link expandMenuItemConsumption} reaches the egg in the mayonnaise in
 * the burger. It reuses the traversal rules {@link costRecipeGraph} established:
 * a sub-recipe contributes `quantity ÷ its yield` of its own inputs, results are
 * memoized so a shared preparation expands once, and cycles resolve to empty
 * rather than hanging.
 */

/** One ingredient's theoretical usage, in the ingredient's own base unit. */
export type ConsumedIngredient = {
  ingredientId: string;
  ingredientName: string;
  baseUnitCode: string;
  /** Total quantity in `baseUnitCode`. */
  quantity: number;
  /** Valued at the ingredient's current unit cost — today's replacement cost, not historical. */
  costMillis: number;
};

/**
 * How much of each ingredient one portion of a menu item requires, flattened
 * through any preparations it contains.
 */
export type MenuItemRequirement = {
  ingredientId: string;
  ingredientName: string;
  baseUnitCode: string;
  /** Per single portion, in `baseUnitCode`. */
  quantityPerUnit: number;
  unitCostMillis: number;
};

/**
 * Flattens menu items into per-portion ingredient requirements.
 *
 * Returns a map of menu item id → the raw ingredients one portion needs. A dish
 * with no composition, or one sitting on a recipe cycle, yields an empty array —
 * it contributes nothing rather than a wrong number.
 *
 * `preparations` and `units` are the same inputs {@link costMenuItems} takes, so
 * a caller that already loaded them for costing can pass them straight through.
 */
export function expandMenuItemConsumption(
  menuNodes: MenuGraphNode[],
  preparations: RecipeGraphNode[],
  units: UnitRow[],
): Map<string, MenuItemRequirement[]> {
  const preparationsById = new Map(preparations.map(node => [node.id, node]));

  /** Memo of recipe id → ingredients needed for ONE unit of that recipe's yield. */
  const perYieldUnit = new Map<string, MenuItemRequirement[]>();
  const inProgress = new Set<string>();

  /** Ingredients required by one unit of `recipeId`'s yield. */
  function resolvePreparation(recipeId: string): MenuItemRequirement[] {
    const cached = perYieldUnit.get(recipeId);
    if (cached) return cached;

    const node = preparationsById.get(recipeId);
    if (!node) return [];

    // A cycle has no fixed point, so it contributes nothing. costRecipeGraph
    // surfaces the path to the user; here it is enough to stop descending.
    if (inProgress.has(recipeId)) return [];

    inProgress.add(recipeId);
    const collected: MenuItemRequirement[] = [];

    for (const line of node.lines) {
      if (line.kind === "recipe") {
        const child = preparationsById.get(line.componentRecipeId);
        const childYieldUnit = child?.yieldUnitCode ?? line.unitCode ?? "";
        const quantityInChildYield = toBaseQuantity(line.quantity, line.unitCode, childYieldUnit, units);

        for (const requirement of resolvePreparation(line.componentRecipeId)) {
          collected.push({
            ...requirement,
            quantityPerUnit: requirement.quantityPerUnit * quantityInChildYield,
          });
        }
        continue;
      }

      collected.push({
        ingredientId: line.ingredientId,
        ingredientName: line.ingredientName,
        baseUnitCode: line.baseUnitCode,
        quantityPerUnit: toBaseQuantity(line.quantity, line.unitCode, line.baseUnitCode, units),
        unitCostMillis: line.unitCostMillis,
      });
    }

    inProgress.delete(recipeId);

    // Batch quantities divided by yield give the per-unit figure: a 2 kg sauce
    // batch using 12 eggs needs 6 eggs per kg. Guarding zero keeps a
    // misconfigured yield from producing Infinity.
    const yieldValue = node.yieldQuantity > 0 ? node.yieldQuantity : 1;
    const perUnit = collected.map(requirement => ({
      ...requirement,
      quantityPerUnit: requirement.quantityPerUnit / yieldValue,
    }));

    perYieldUnit.set(recipeId, perUnit);
    return perUnit;
  }

  const byMenuItemId = new Map<string, MenuItemRequirement[]>();

  for (const menuNode of menuNodes) {
    const collected: MenuItemRequirement[] = [];

    for (const line of menuNode.lines) {
      if (line.kind === "recipe") {
        const child = preparationsById.get(line.componentRecipeId);
        const childYieldUnit = child?.yieldUnitCode ?? line.unitCode ?? "";
        const quantityInChildYield = toBaseQuantity(line.quantity, line.unitCode, childYieldUnit, units);

        for (const requirement of resolvePreparation(line.componentRecipeId)) {
          collected.push({
            ...requirement,
            quantityPerUnit: requirement.quantityPerUnit * quantityInChildYield,
          });
        }
        continue;
      }

      collected.push({
        ingredientId: line.ingredientId,
        ingredientName: line.ingredientName,
        baseUnitCode: line.baseUnitCode,
        quantityPerUnit: toBaseQuantity(line.quantity, line.unitCode, line.baseUnitCode, units),
        unitCostMillis: line.unitCostMillis,
      });
    }

    // A menu item's yield is portions per composition, so a recipe producing 4
    // portions divides by 4 to give one plate.
    const portions = menuNode.yieldQuantity > 0 ? menuNode.yieldQuantity : 1;
    byMenuItemId.set(
      menuNode.id,
      mergeRequirements(collected.map(requirement => ({
        ...requirement,
        quantityPerUnit: requirement.quantityPerUnit / portions,
      }))),
    );
  }

  return byMenuItemId;
}

/**
 * Collapses repeated ingredients into one row.
 *
 * An ingredient can arrive by several paths — onion directly in the dish and
 * again inside its sauce. Those are the same physical demand on the same shelf,
 * so they must sum rather than appear twice.
 */
function mergeRequirements(requirements: MenuItemRequirement[]): MenuItemRequirement[] {
  const byIngredient = new Map<string, MenuItemRequirement>();

  for (const requirement of requirements) {
    const existing = byIngredient.get(requirement.ingredientId);
    if (existing) {
      existing.quantityPerUnit += requirement.quantityPerUnit;
      continue;
    }
    byIngredient.set(requirement.ingredientId, { ...requirement });
  }

  return [...byIngredient.values()];
}

/** A menu item and how many portions of it were sold. */
export type SoldQuantity = { menuItemId: string; quantity: number };

/**
 * Multiplies units sold by per-portion requirements to get period consumption.
 *
 * Sales of a dish whose composition is empty contribute nothing, which is the
 * honest answer: an uncosted dish has no known ingredient demand. Callers that
 * need to warn about this should compare against
 * {@link countUnmappedSales}.
 */
export function calculateTheoreticalConsumption(
  sold: SoldQuantity[],
  requirementsByMenuItem: Map<string, MenuItemRequirement[]>,
): ConsumedIngredient[] {
  const byIngredient = new Map<string, ConsumedIngredient>();

  for (const { menuItemId, quantity } of sold) {
    if (quantity <= 0) continue;
    const requirements = requirementsByMenuItem.get(menuItemId);
    if (!requirements?.length) continue;

    for (const requirement of requirements) {
      const consumed = requirement.quantityPerUnit * quantity;
      const existing = byIngredient.get(requirement.ingredientId);

      if (existing) {
        existing.quantity += consumed;
        existing.costMillis += consumed * requirement.unitCostMillis;
        continue;
      }

      byIngredient.set(requirement.ingredientId, {
        ingredientId: requirement.ingredientId,
        ingredientName: requirement.ingredientName,
        baseUnitCode: requirement.baseUnitCode,
        quantity: consumed,
        costMillis: consumed * requirement.unitCostMillis,
      });
    }
  }

  // Rounding is deferred to the end so a thousand small lines do not accumulate
  // a thousand rounding errors, matching how costing.ts totals its lines.
  return [...byIngredient.values()]
    .map(row => ({ ...row, costMillis: Math.round(row.costMillis) }))
    .sort((a, b) => b.costMillis - a.costMillis);
}

/**
 * How many sold units belong to dishes with no usable composition.
 *
 * Surfaced next to a consumption report so an implausibly small figure is
 * visibly explained by unmapped dishes rather than read as low usage.
 */
export function countUnmappedSales(
  sold: SoldQuantity[],
  requirementsByMenuItem: Map<string, MenuItemRequirement[]>,
): { units: number; menuItemIds: string[] } {
  let units = 0;
  const menuItemIds = new Set<string>();

  for (const { menuItemId, quantity } of sold) {
    if (quantity <= 0) continue;
    if (requirementsByMenuItem.get(menuItemId)?.length) continue;
    units += quantity;
    menuItemIds.add(menuItemId);
  }

  return { units, menuItemIds: [...menuItemIds] };
}
