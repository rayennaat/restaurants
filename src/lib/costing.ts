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

export type RecipeIngredientInput = {
  ingredientId: string;
  ingredientName: string;
  /** Quantity as entered by the user, expressed in `unitCode`. */
  quantity: number;
  unitCode: string | null;
  baseUnitCode: string;
  /** Current cost of one base unit of this ingredient. */
  unitCostMillis: number;
};

export type CostedRecipeLine = RecipeIngredientInput & {
  /** `quantity` converted into the ingredient base unit. */
  baseQuantity: number;
  /** Cost contribution of this line, in minor currency units. */
  lineCostMillis: number;
  /** Share of the recipe total this line represents, 0-100. */
  sharePercent: number;
};

export type RecipeCosting = {
  lines: CostedRecipeLine[];
  /** Cost of one full production batch. */
  totalCostMillis: number;
  /** Cost of a single serving/portion. */
  costPerServingMillis: number;
  yieldQuantity: number;
  /** True when at least one ingredient still has no known cost. */
  hasUncostedIngredient: boolean;
};

/** Prices a recipe from its lines and the org unit table. */
export function costRecipe(lines: RecipeIngredientInput[], yieldQuantity: number, units: UnitRow[]): RecipeCosting {
  const priced = lines.map(line => {
    const baseQuantity = toBaseQuantity(line.quantity, line.unitCode, line.baseUnitCode, units);
    return { ...line, baseQuantity, lineCostMillis: Math.round(baseQuantity * line.unitCostMillis), sharePercent: 0 };
  });

  const totalCostMillis = priced.reduce((total, line) => total + line.lineCostMillis, 0);
  const yieldValue = yieldQuantity > 0 ? yieldQuantity : 1;

  return {
    lines: priced.map(line => ({ ...line, sharePercent: totalCostMillis > 0 ? (line.lineCostMillis / totalCostMillis) * 100 : 0 })),
    totalCostMillis,
    costPerServingMillis: Math.round(totalCostMillis / yieldValue),
    yieldQuantity: yieldValue,
    hasUncostedIngredient: priced.some(line => line.unitCostMillis <= 0),
  };
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
  /** False when the item has no recipe attached, so the numbers are incomplete. */
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
