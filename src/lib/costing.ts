import { toBaseQuantity, type UnitRow } from "./units";

/**
 * Recipe and menu cost engine.
 *
 * Nothing here is persisted: every figure is derived from the current
 * `ingredients.latest_unit_cost_millis`, so a supplier price change recorded by
 * a purchase immediately re-prices every recipe and menu item that uses it.
 * All money values are integer minor currency units (see `lib/money`).
 */

export type RecipeLine = { quantityInBaseUnit: number; unitCostMillis: number };

/** Cost of a set of already-converted recipe lines, in minor currency units. */
export function calculateRecipeCost(lines: RecipeLine[]) {
  return Math.round(lines.reduce((total, line) => total + line.quantityInBaseUnit * line.unitCostMillis, 0));
}

/** Gross margin percentage of a selling price against a cost. */
export function calculateMargin(sellingPriceMillis: number, costMillis: number) {
  if (sellingPriceMillis <= 0) return 0;
  return ((sellingPriceMillis - costMillis) / sellingPriceMillis) * 100;
}

export function convertToBaseUnit(quantity: number, multiplierToBase: number) {
  return quantity * multiplierToBase;
}

/** Food cost percentage — the share of the selling price consumed by cost. */
export function calculateFoodCostPercent(sellingPriceMillis: number, costMillis: number) {
  if (sellingPriceMillis <= 0) return 0;
  return (costMillis / sellingPriceMillis) * 100;
}

/** A recipe line consuming a raw ingredient. */
export type RecipeIngredientInput = {
  kind?: "ingredient";
  ingredientId: string;
  ingredientName: string;
  /** Quantity as entered by the user, expressed in `unitCode`. */
  quantity: number;
  unitCode: string | null;
  baseUnitCode: string;
  /** Current cost of one base unit of this ingredient. */
  unitCostMillis: number;
};

/** A recipe line consuming another recipe as a sub-preparation. */
export type RecipeComponentInput = {
  kind: "recipe";
  componentRecipeId: string;
  componentName: string;
  /** Quantity of the sub-recipe's yield unit that this line consumes. */
  quantity: number;
  unitCode: string | null;
};

export type RecipeLineInput = RecipeIngredientInput | RecipeComponentInput;

export type CostedRecipeLine = {
  kind: "ingredient" | "recipe";
  /** Ingredient id, or component recipe id for sub-recipe lines. */
  targetId: string;
  name: string;
  quantity: number;
  unitCode: string | null;
  /** The unit `quantity` was converted into: the ingredient base unit, or the sub-recipe yield unit. */
  baseUnitCode: string;
  /** `quantity` converted into `baseUnitCode`. */
  baseQuantity: number;
  /** Cost of one `baseUnitCode` of this line's target. */
  unitCostMillis: number;
  /** Cost contribution of this line, in minor currency units. */
  lineCostMillis: number;
  /** Share of the recipe total this line represents, 0-100. */
  sharePercent: number;
  /** True when this line's cost could not be determined. */
  isUncosted: boolean;
};

export type RecipeCosting = {
  lines: CostedRecipeLine[];
  /** Cost of one full production batch. */
  totalCostMillis: number;
  /** Cost of a single serving/portion — also the cost of one yield unit. */
  costPerServingMillis: number;
  yieldQuantity: number;
  yieldUnitCode: string | null;
  /** True when at least one ingredient or sub-recipe still has no known cost. */
  hasUncostedIngredient: boolean;
  /** Names of recipes forming a circular dependency, empty when the graph is sound. */
  circularPath: string[];
  /** How many levels of sub-recipe this recipe depends on. 0 for raw-only recipes. */
  depth: number;
};

/** A recipe plus its lines, as fed to the graph cost engine. */
export type RecipeGraphNode = {
  id: string;
  name: string;
  yieldQuantity: number;
  yieldUnitCode: string | null;
  lines: RecipeLineInput[];
};

const emptyCosting = (node: Pick<RecipeGraphNode, "yieldQuantity" | "yieldUnitCode">, circularPath: string[] = []): RecipeCosting => ({
  lines: [],
  totalCostMillis: 0,
  costPerServingMillis: 0,
  yieldQuantity: node.yieldQuantity > 0 ? node.yieldQuantity : 1,
  yieldUnitCode: node.yieldUnitCode,
  hasUncostedIngredient: true,
  circularPath,
  depth: 0,
});

/**
 * Prices an entire recipe graph, resolving sub-recipe lines recursively.
 *
 * A sub-recipe contributes `quantity × (its batch cost ÷ its yield)`, so a
 * 1 kg batch of mayonnaise costing 8.400 makes 15 g of it cost 0.126. Results
 * are memoized, so a preparation shared by ten dishes is costed once.
 *
 * Cycles cannot be costed at all (A needs B needs A has no fixed point), so any
 * recipe on a cycle is returned at zero cost with `circularPath` naming the loop
 * for the UI to surface. The DB rejects direct self-reference; this catches the
 * indirect cases.
 */
export function costRecipeGraph(nodes: RecipeGraphNode[], units: UnitRow[]): Map<string, RecipeCosting> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const memo = new Map<string, RecipeCosting>();
  const inProgress = new Set<string>();

  function resolve(id: string, stack: string[]): RecipeCosting {
    const cached = memo.get(id);
    if (cached) return cached;

    const node = byId.get(id);
    if (!node) return emptyCosting({ yieldQuantity: 1, yieldUnitCode: null });

    if (inProgress.has(id)) {
      // Report the loop from its first occurrence so the message reads as a cycle.
      const start = stack.indexOf(id);
      const path = [...stack.slice(start === -1 ? 0 : start), node.name];
      return emptyCosting(node, path);
    }

    inProgress.add(id);
    let depth = 0;
    let circularPath: string[] = [];

    const priced: CostedRecipeLine[] = node.lines.map(line => {
      if (line.kind === "recipe") {
        const child = byId.get(line.componentRecipeId);
        const childCosting = resolve(line.componentRecipeId, [...stack, node.name]);
        if (childCosting.circularPath.length && !circularPath.length) circularPath = childCosting.circularPath;
        depth = Math.max(depth, childCosting.depth + 1);

        // The sub-recipe is measured in its own yield unit; convert this line into it.
        // A yield unit is optional, in which case the line unit is taken as-is.
        const yieldUnit = child?.yieldUnitCode ?? line.unitCode ?? "";
        const baseQuantity = toBaseQuantity(line.quantity, line.unitCode, yieldUnit, units);
        const unitCostMillis = childCosting.costPerServingMillis;

        return {
          kind: "recipe" as const,
          targetId: line.componentRecipeId,
          name: line.componentName,
          quantity: line.quantity,
          unitCode: line.unitCode,
          baseUnitCode: yieldUnit,
          baseQuantity,
          unitCostMillis,
          lineCostMillis: Math.round(baseQuantity * unitCostMillis),
          sharePercent: 0,
          isUncosted: unitCostMillis <= 0,
        };
      }

      const baseQuantity = toBaseQuantity(line.quantity, line.unitCode, line.baseUnitCode, units);
      return {
        kind: "ingredient" as const,
        targetId: line.ingredientId,
        name: line.ingredientName,
        quantity: line.quantity,
        unitCode: line.unitCode,
        baseUnitCode: line.baseUnitCode,
        baseQuantity,
        unitCostMillis: line.unitCostMillis,
        lineCostMillis: Math.round(baseQuantity * line.unitCostMillis),
        sharePercent: 0,
        isUncosted: line.unitCostMillis <= 0,
      };
    });

    inProgress.delete(id);

    if (circularPath.length) {
      const broken = emptyCosting(node, circularPath);
      memo.set(id, broken);
      return broken;
    }

    const totalCostMillis = priced.reduce((total, line) => total + line.lineCostMillis, 0);
    const yieldValue = node.yieldQuantity > 0 ? node.yieldQuantity : 1;

    const costing: RecipeCosting = {
      lines: priced.map(line => ({ ...line, sharePercent: totalCostMillis > 0 ? (line.lineCostMillis / totalCostMillis) * 100 : 0 })),
      totalCostMillis,
      costPerServingMillis: Math.round(totalCostMillis / yieldValue),
      yieldQuantity: yieldValue,
      yieldUnitCode: node.yieldUnitCode,
      // A recipe with no lines is not "free" — it is simply not costed yet.
      hasUncostedIngredient: priced.length === 0 || priced.some(line => line.isUncosted),
      circularPath: [],
      depth,
    };

    memo.set(id, costing);
    return costing;
  }

  for (const node of nodes) resolve(node.id, []);
  return memo;
}

/** A menu item plus its lines. Same shape as a recipe node, minus the yield unit. */
export type MenuGraphNode = {
  id: string;
  name: string;
  /** How many portions the lines produce. */
  yieldQuantity: number;
  lines: RecipeLineInput[];
};

/** Namespaces menu nodes so a menu item id can never shadow a recipe id in the graph. */
const menuNodeId = (id: string) => `menu:${id}`;

/**
 * Prices menu items against the preparation graph.
 *
 * A menu item is a leaf: preparations feed into it and nothing consumes it, so it
 * joins the same graph as an ordinary node and cannot introduce a cycle. Running
 * one pass over preparations and dishes together means a preparation shared by
 * twenty dishes is still costed once.
 *
 * The returned `costPerServingMillis` is the cost of one portion, which is what
 * {@link calculateMenuEconomics} expects.
 */
export function costMenuItems(menuNodes: MenuGraphNode[], preparations: RecipeGraphNode[], units: UnitRow[]): Map<string, RecipeCosting> {
  const graph = costRecipeGraph(
    [...preparations, ...menuNodes.map(node => ({ ...node, id: menuNodeId(node.id), yieldUnitCode: null }))],
    units,
  );

  const byMenuItemId = new Map<string, RecipeCosting>();
  for (const node of menuNodes) {
    const costing = graph.get(menuNodeId(node.id));
    if (costing) byMenuItemId.set(node.id, costing);
  }
  return byMenuItemId;
}

/** Prices a single recipe with no sub-recipe lines. Thin wrapper over the graph engine. */
export function costRecipe(lines: RecipeIngredientInput[], yieldQuantity: number, units: UnitRow[], yieldUnitCode: string | null = null): RecipeCosting {
  const id = "__single__";
  return (
    costRecipeGraph([{ id, name: "", yieldQuantity, yieldUnitCode, lines }], units).get(id) ?? emptyCosting({ yieldQuantity, yieldUnitCode })
  );
}

/**
 * Every recipe reachable from `recipeId` through sub-recipe lines.
 * Used to reject a component that would close a loop before it is saved.
 */
export function collectRecipeDependencies(recipeId: string, edges: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [...(edges.get(recipeId) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(edges.get(next) ?? []));
  }
  return seen;
}

export type MenuEconomics = {
  sellingPriceMillis: number;
  /** Recipe cost of one serving. */
  recipeCostMillis: number;
  packagingCostMillis: number;
  /** Recipe cost plus packaging. */
  totalCostMillis: number;
  grossProfitMillis: number;
  foodCostPercent: number;
  grossMarginPercent: number;
  /** False when the item has no lines yet, so the numbers are incomplete. */
  isCosted: boolean;
};

/** Turns a selling price and a costed recipe into the profit figures shown on menu screens. */
export function calculateMenuEconomics(input: {
  sellingPriceMillis: number;
  recipeCostMillis: number;
  packagingCostMillis?: number;
  isCosted?: boolean;
}): MenuEconomics {
  const packagingCostMillis = input.packagingCostMillis ?? 0;
  const totalCostMillis = input.recipeCostMillis + packagingCostMillis;
  return {
    sellingPriceMillis: input.sellingPriceMillis,
    recipeCostMillis: input.recipeCostMillis,
    packagingCostMillis,
    totalCostMillis,
    grossProfitMillis: input.sellingPriceMillis - totalCostMillis,
    foodCostPercent: calculateFoodCostPercent(input.sellingPriceMillis, totalCostMillis),
    grossMarginPercent: calculateMargin(input.sellingPriceMillis, totalCostMillis),
    isCosted: input.isCosted ?? true,
  };
}

/**
 * Restaurant food-cost rule of thumb: at or under 30% is healthy, up to 35% is
 * watchable, above that the item is eroding margin.
 */
export function foodCostTone(foodCostPercent: number): "success" | "warning" | "danger" {
  if (foodCostPercent <= 0) return "warning";
  if (foodCostPercent <= 30) return "success";
  if (foodCostPercent <= 35) return "warning";
  return "danger";
}

/** Revenue-weighted average margin across menu items, used for the dashboard KPI. */
export function averageMargin(items: { sellingPriceMillis: number; totalCostMillis: number }[]) {
  const priced = items.filter(item => item.sellingPriceMillis > 0);
  if (!priced.length) return 0;
  const revenue = priced.reduce((total, item) => total + item.sellingPriceMillis, 0);
  const cost = priced.reduce((total, item) => total + item.totalCostMillis, 0);
  return calculateMargin(revenue, cost);
}

/**
 * Menu-wide food cost percentage: total plate cost against total menu price.
 *
 * This is the same ratio {@link calculateFoodCostPercent} applies to one item,
 * widened across the menu — it answers "what share of a typical sale goes to
 * ingredients". It deliberately weights by menu price rather than by units sold,
 * because the schema records no sales: there is no orders table, so a true
 * period COGS-over-revenue food cost cannot be derived. Returns null when no
 * item is both priced and costed, so callers show an empty state instead of 0%.
 */
export function menuFoodCostPercent(items: { sellingPriceMillis: number; totalCostMillis: number; isCosted: boolean }[]): number | null {
  const usable = items.filter(item => item.isCosted && item.sellingPriceMillis > 0 && item.totalCostMillis > 0);
  if (!usable.length) return null;
  const revenue = usable.reduce((total, item) => total + item.sellingPriceMillis, 0);
  const cost = usable.reduce((total, item) => total + item.totalCostMillis, 0);
  return calculateFoodCostPercent(revenue, cost);
}

/**
 * Revenue-weighted margin, or null when nothing can be measured.
 *
 * {@link averageMargin} returns 0 for an empty menu, which reads as "we make no
 * money" rather than "we have nothing to measure yet". Dashboards use this.
 */
export function averageMarginOrNull(items: { sellingPriceMillis: number; totalCostMillis: number; isCosted: boolean }[]): number | null {
  const usable = items.filter(item => item.isCosted && item.sellingPriceMillis > 0);
  if (!usable.length) return null;
  return averageMargin(usable);
}
