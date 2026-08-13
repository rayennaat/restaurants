import { describe, expect, it } from "vitest";
import {
  calculateMargin,
  calculateMenuEconomics,
  calculateRecipeCost,
  collectRecipeDependencies,
  convertToBaseUnit,
  costMenuItems,
  costRecipeGraph,
  type MenuGraphNode,
  type RecipeGraphNode,
} from "./costing";
import type { UnitRow } from "./units";

const units: UnitRow[] = [
  { code: "kg", name: "Kilogram", dimension: "mass", multiplierToBase: 1, isBase: true },
  { code: "g", name: "Gram", dimension: "mass", multiplierToBase: 0.001, isBase: false },
  { code: "L", name: "Litre", dimension: "volume", multiplierToBase: 1, isBase: true },
  { code: "ml", name: "Millilitre", dimension: "volume", multiplierToBase: 0.001, isBase: false },
];

function ingredientLine(id: string, name: string, quantity: number, unitCode: string, unitCostMillis: number, baseUnitCode = "kg") {
  return { kind: "ingredient" as const, ingredientId: id, ingredientName: name, quantity, unitCode, baseUnitCode, unitCostMillis };
}

function node(overrides: Partial<RecipeGraphNode> & Pick<RecipeGraphNode, "id" | "name">): RecipeGraphNode {
  return { yieldQuantity: 1, yieldUnitCode: null, lines: [], ...overrides };
}

describe("costing primitives", () => {
  it("calculates recipe cost", () =>
    expect(calculateRecipeCost([{ quantityInBaseUnit: 0.15, unitCostMillis: 18000 }, { quantityInBaseUnit: 1, unitCostMillis: 700 }])).toBe(3400));
  it("calculates gross margin", () => expect(calculateMargin(15000, 6000)).toBe(60));
  it("converts units", () => expect(convertToBaseUnit(2.5, 1000)).toBe(2500));
});

describe("costRecipeGraph", () => {
  it("costs a flat recipe and divides by yield", () => {
    const costing = costRecipeGraph(
      [node({ id: "r1", name: "Soup", yieldQuantity: 4, lines: [ingredientLine("i1", "Tomato", 500, "g", 3000), ingredientLine("i2", "Cream", 200, "ml", 8000, "L")] })],
      units,
    ).get("r1")!;

    // 0.5 kg * 3000 = 1500, 0.2 L * 8000 = 1600
    expect(costing.totalCostMillis).toBe(3100);
    expect(costing.costPerServingMillis).toBe(775);
    expect(costing.hasUncostedIngredient).toBe(false);
  });

  it("flows a preparation's per-unit cost into the parent recipe", () => {
    const graph = costRecipeGraph(
      [
        // 2 kg of mayo costing 3600 millimes -> 1800 per kg.
        node({ id: "prep", name: "Mayonnaise", yieldQuantity: 2, yieldUnitCode: "kg", lines: [ingredientLine("oil", "Oil", 2, "kg", 1800)] }),
        node({ id: "dish", name: "Sandwich", yieldQuantity: 1, lines: [{ kind: "recipe", componentRecipeId: "prep", componentName: "Mayonnaise", quantity: 15, unitCode: "g" }] }),
      ],
      units,
    );

    expect(graph.get("prep")!.costPerServingMillis).toBe(1800);
    // 15 g of a 1800/kg preparation = 27 millimes.
    expect(graph.get("dish")!.totalCostMillis).toBe(27);
    expect(graph.get("dish")!.depth).toBe(1);
  });

  it("resolves three levels deep", () => {
    const graph = costRecipeGraph(
      [
        node({ id: "a", name: "Stock", yieldQuantity: 4, yieldUnitCode: "L", lines: [ingredientLine("bone", "Bones", 2, "kg", 4000)] }),
        node({ id: "b", name: "Sauce", yieldQuantity: 2, yieldUnitCode: "L", lines: [{ kind: "recipe", componentRecipeId: "a", componentName: "Stock", quantity: 1, unitCode: "L" }] }),
        node({ id: "c", name: "Dish", yieldQuantity: 1, lines: [{ kind: "recipe", componentRecipeId: "b", componentName: "Sauce", quantity: 250, unitCode: "ml" }] }),
      ],
      units,
    );

    expect(graph.get("a")!.costPerServingMillis).toBe(2000); // 8000 / 4 L
    expect(graph.get("b")!.costPerServingMillis).toBe(1000); // 2000 / 2 L
    expect(graph.get("c")!.totalCostMillis).toBe(250); // 0.25 L * 1000
    expect(graph.get("c")!.depth).toBe(2);
  });

  it("reports a cycle instead of recursing forever", () => {
    const graph = costRecipeGraph(
      [
        node({ id: "x", name: "X", lines: [{ kind: "recipe", componentRecipeId: "y", componentName: "Y", quantity: 1, unitCode: "kg" }] }),
        node({ id: "y", name: "Y", lines: [{ kind: "recipe", componentRecipeId: "x", componentName: "X", quantity: 1, unitCode: "kg" }] }),
      ],
      units,
    );

    expect(graph.get("x")!.circularPath.length).toBeGreaterThan(0);
    expect(graph.get("x")!.totalCostMillis).toBe(0);
  });

  it("flags a missing component rather than silently costing zero", () => {
    const costing = costRecipeGraph([node({ id: "r", name: "R", lines: [{ kind: "recipe", componentRecipeId: "gone", componentName: "Deleted", quantity: 1, unitCode: "kg" }] })], units).get("r")!;
    expect(costing.hasUncostedIngredient).toBe(true);
  });

  it("treats an empty recipe as uncosted", () => {
    const costing = costRecipeGraph([node({ id: "empty", name: "Empty" })], units).get("empty")!;
    expect(costing.totalCostMillis).toBe(0);
    expect(costing.hasUncostedIngredient).toBe(true);
  });
});

describe("collectRecipeDependencies", () => {
  it("walks transitively and survives an existing cycle", () => {
    const edges = new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]]);
    expect([...collectRecipeDependencies("a", edges)].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("costMenuItems", () => {
  function dish(overrides: Partial<MenuGraphNode> & Pick<MenuGraphNode, "id" | "name">): MenuGraphNode {
    return { yieldQuantity: 1, lines: [], ...overrides };
  }

  it("costs a dish from its own raw lines", () => {
    const costing = costMenuItems([dish({ id: "m1", name: "Salad", lines: [ingredientLine("i1", "Tomato", 200, "g", 3000)] })], [], units).get("m1")!;
    expect(costing.totalCostMillis).toBe(600); // 0.2 kg * 3000
    expect(costing.costPerServingMillis).toBe(600);
  });

  it("divides a batch across its portions", () => {
    const costing = costMenuItems(
      [dish({ id: "m1", name: "Soup", yieldQuantity: 4, lines: [ingredientLine("i1", "Tomato", 500, "g", 3000), ingredientLine("i2", "Cream", 200, "ml", 8000, "L")] })],
      [],
      units,
    ).get("m1")!;
    expect(costing.totalCostMillis).toBe(3100);
    expect(costing.costPerServingMillis).toBe(775);
  });

  it("pulls a preparation's per-yield-unit cost into the dish", () => {
    // 2 kg of mayo costing 3600 millimes -> 1800 per kg.
    const preparations: RecipeGraphNode[] = [node({ id: "prep", name: "Mayonnaise", yieldQuantity: 2, yieldUnitCode: "kg", lines: [ingredientLine("oil", "Oil", 2, "kg", 1800)] })];
    const costing = costMenuItems(
      [
        dish({
          id: "burger",
          name: "Burger",
          lines: [ingredientLine("bun", "Bun", 1, "kg", 750), { kind: "recipe", componentRecipeId: "prep", componentName: "Mayonnaise", quantity: 15, unitCode: "g" }],
        }),
      ],
      preparations,
      units,
    ).get("burger")!;

    // 750 for the bun + 15 g of a 1800/kg preparation = 27.
    expect(costing.totalCostMillis).toBe(777);
    expect(costing.depth).toBe(1);
  });

  it("keys results by the plain menu item id even when one matches a recipe id", () => {
    const shared = "same-id";
    const preparations: RecipeGraphNode[] = [node({ id: shared, name: "Stock", yieldQuantity: 1, yieldUnitCode: "L", lines: [ingredientLine("bone", "Bones", 1, "kg", 4000)] })];
    const costing = costMenuItems([dish({ id: shared, name: "Dish", lines: [ingredientLine("i1", "Tomato", 1, "kg", 1000)] })], preparations, units).get(shared)!;

    // The dish's own line, not the identically-identified preparation's.
    expect(costing.totalCostMillis).toBe(1000);
  });

  it("treats a dish with no lines as uncosted rather than free", () => {
    const costing = costMenuItems([dish({ id: "m1", name: "Empty" })], [], units).get("m1")!;
    expect(costing.totalCostMillis).toBe(0);
    expect(costing.hasUncostedIngredient).toBe(true);
  });
});

describe("calculateMenuEconomics", () => {
  it("derives food cost, profit and margin including packaging", () => {
    const economics = calculateMenuEconomics({ sellingPriceMillis: 12000, recipeCostMillis: 3000, packagingCostMillis: 600 });
    expect(economics.totalCostMillis).toBe(3600);
    expect(economics.foodCostPercent).toBe(30);
    expect(economics.grossProfitMillis).toBe(8400);
    expect(economics.grossMarginPercent).toBe(70);
  });

  it("does not divide by zero on a free item", () => {
    const economics = calculateMenuEconomics({ sellingPriceMillis: 0, recipeCostMillis: 500, packagingCostMillis: 0 });
    expect(Number.isFinite(economics.foodCostPercent)).toBe(true);
  });
});
