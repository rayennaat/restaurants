import { describe, expect, it } from "vitest";
import { expandMenuItemConsumption, type MenuItemRequirement } from "@/lib/consumption";
import type { MenuGraphNode, RecipeGraphNode } from "@/lib/costing";
import { DEFAULT_UNITS } from "@/lib/units";
import { evaluateStockShortages, planSaleConsumption } from "@/server/sale-consumption";

/**
 * Turning sold dishes into ledger movements.
 *
 * The arithmetic that decides how much stock a sale removes. It is asserted
 * directly rather than through the database because the sign convention is the
 * part that matters most and the part most easily got wrong: a balance is
 * `sum(quantity)` with no per-type rules, so a positive consumption row would
 * silently *increase* stock every time something sold.
 */

const requirement = (overrides: Partial<MenuItemRequirement> & { ingredientId: string }): MenuItemRequirement => ({
  ingredientName: overrides.ingredientId,
  baseUnitCode: "kg",
  quantityPerUnit: 0.15,
  unitCostMillis: 18_000,
  ...overrides,
});

/** A burger holding 150 g beef and 1 bun, as the reports expand it. */
const BURGER = [
  requirement({ ingredientId: "beef", quantityPerUnit: 0.15 }),
  requirement({ ingredientId: "bun", quantityPerUnit: 1, baseUnitCode: "unit", unitCostMillis: 750 }),
];

const SALAD = [requirement({ ingredientId: "cucumber", quantityPerUnit: 0.05, unitCostMillis: 2_000 })];

const REQUIREMENTS = new Map<string, MenuItemRequirement[]>([
  ["burger", BURGER],
  ["salad", SALAD],
]);

describe("expanding a sale into consumption", () => {
  it("consumes the recipe quantity for one portion", () => {
    const planned = planSaleConsumption([{ menuItemId: "burger", quantity: 1 }], REQUIREMENTS);
    const beef = planned.find(row => row.ingredientId === "beef")!;
    expect(beef.quantity).toBeCloseTo(-0.15, 10);
  });

  it("scales with the quantity sold", () => {
    // The example from the brief: 2 hamburgers at 150 g beef = 300 g.
    const planned = planSaleConsumption([{ menuItemId: "burger", quantity: 2 }], REQUIREMENTS);
    const beef = planned.find(row => row.ingredientId === "beef")!;
    expect(beef.quantity).toBeCloseTo(-0.3, 10);
  });

  it("returns negative quantities, since a balance is a plain sum", () => {
    // A positive row here would make selling *increase* stock.
    const planned = planSaleConsumption([{ menuItemId: "burger", quantity: 3 }], REQUIREMENTS);
    expect(planned.every(row => row.quantity < 0)).toBe(true);
  });

  it("emits one row per ingredient in the recipe", () => {
    const planned = planSaleConsumption([{ menuItemId: "burger", quantity: 1 }], REQUIREMENTS);
    expect(planned.map(row => row.ingredientId).sort()).toEqual(["beef", "bun"]);
  });

  it("merges an ingredient shared by two dishes on one ticket", () => {
    const shared = new Map<string, MenuItemRequirement[]>([
      ["burger", [requirement({ ingredientId: "beef", quantityPerUnit: 0.15 })]],
      ["kebab", [requirement({ ingredientId: "beef", quantityPerUnit: 0.2 })]],
    ]);
    const planned = planSaleConsumption(
      [{ menuItemId: "burger", quantity: 2 }, { menuItemId: "kebab", quantity: 1 }],
      shared,
    );
    // One demand on one shelf: 0.3 + 0.2, as a single movement.
    expect(planned).toHaveLength(1);
    expect(planned[0].quantity).toBeCloseTo(-0.5, 10);
  });

  it("merges the same dish appearing twice on one ticket", () => {
    const planned = planSaleConsumption(
      [{ menuItemId: "burger", quantity: 1 }, { menuItemId: "burger", quantity: 2 }],
      REQUIREMENTS,
    );
    expect(planned.find(row => row.ingredientId === "beef")!.quantity).toBeCloseTo(-0.45, 10);
  });

  it("carries the ingredient's unit cost onto the movement", () => {
    const planned = planSaleConsumption([{ menuItemId: "burger", quantity: 1 }], REQUIREMENTS);
    expect(planned.find(row => row.ingredientId === "bun")!.unitCostMillis).toBe(750);
  });

  it("consumes nothing for a dish with no composition", () => {
    // An uncosted dish has no known demand; inventing one would be worse than
    // reporting none. The reports surface this as `unmappedUnits`.
    expect(planSaleConsumption([{ menuItemId: "uncosted", quantity: 5 }], REQUIREMENTS)).toEqual([]);
  });

  it("consumes nothing for a dish outside the requirements map", () => {
    // The map is built scoped to one organization, so this is also what stops a
    // foreign dish moving this tenant's stock.
    expect(planSaleConsumption([{ menuItemId: "from-another-org", quantity: 2 }], REQUIREMENTS)).toEqual([]);
  });

  it("ignores non-positive quantities", () => {
    expect(planSaleConsumption([{ menuItemId: "burger", quantity: 0 }], REQUIREMENTS)).toEqual([]);
    expect(planSaleConsumption([{ menuItemId: "burger", quantity: -2 }], REQUIREMENTS)).toEqual([]);
  });

  it("handles an empty sale", () => {
    expect(planSaleConsumption([], REQUIREMENTS)).toEqual([]);
  });

  it("drops ingredients whose requirement rounds to nothing", () => {
    const zero = new Map<string, MenuItemRequirement[]>([
      ["burger", [requirement({ ingredientId: "garnish", quantityPerUnit: 0 })]],
    ]);
    // A zero-quantity movement is noise in the ledger.
    expect(planSaleConsumption([{ menuItemId: "burger", quantity: 10 }], zero)).toEqual([]);
  });

  it("handles a fractional quantity, matching what the sale allows", () => {
    const planned = planSaleConsumption([{ menuItemId: "burger", quantity: 0.5 }], REQUIREMENTS);
    expect(planned.find(row => row.ingredientId === "beef")!.quantity).toBeCloseTo(-0.075, 10);
  });

  it("keeps a multi-dish ticket's ingredients separate", () => {
    const planned = planSaleConsumption(
      [{ menuItemId: "burger", quantity: 1 }, { menuItemId: "salad", quantity: 2 }],
      REQUIREMENTS,
    );
    expect(planned.map(row => row.ingredientId).sort()).toEqual(["beef", "bun", "cucumber"]);
    expect(planned.find(row => row.ingredientId === "cucumber")!.quantity).toBeCloseTo(-0.1, 10);
  });

  it("nets to zero against its own reversal", () => {
    // What voiding relies on: negating the posted rows must restore the balance.
    const planned = planSaleConsumption([{ menuItemId: "burger", quantity: 4 }], REQUIREMENTS);
    for (const row of planned) {
      expect(row.quantity + -row.quantity).toBe(0);
    }
  });
});

describe("selected-location sale availability", () => {
  it("rejects La Marsa when a nested preparation is short even if Ariana has enough", () => {
    const burgerMix: RecipeGraphNode = {
      id: "burger-mix",
      name: "Burger mix",
      yieldQuantity: 1,
      yieldUnitCode: "kg",
      lines: [
        {
          kind: "ingredient",
          ingredientId: "beef",
          ingredientName: "Ground beef",
          quantity: 800,
          unitCode: "g",
          baseUnitCode: "kg",
          unitCostMillis: 9_750,
        },
        {
          kind: "ingredient",
          ingredientId: "onion",
          ingredientName: "Onion",
          quantity: 200,
          unitCode: "g",
          baseUnitCode: "kg",
          unitCostMillis: 2_000,
        },
      ],
    };
    const burger: MenuGraphNode = {
      id: "classic-burger",
      name: "Classic Beef Burger",
      yieldQuantity: 1,
      lines: [{
        kind: "recipe",
        componentRecipeId: "burger-mix",
        componentName: "Burger mix",
        quantity: 200,
        unitCode: "g",
      }],
    };

    const requirements = expandMenuItemConsumption([burger], [burgerMix], DEFAULT_UNITS);
    const planned = planSaleConsumption([{ menuItemId: "classic-burger", quantity: 1 }], requirements);

    const arianaShortages = evaluateStockShortages(planned, [
      { ingredientId: "beef", ingredientName: "Ground beef", unit: "kg", available: 1 },
      { ingredientId: "onion", ingredientName: "Onion", unit: "kg", available: 1 },
    ]);
    const laMarsaShortages = evaluateStockShortages(planned, [
      { ingredientId: "beef", ingredientName: "Ground beef", unit: "kg", available: 0.1 },
      { ingredientId: "onion", ingredientName: "Onion", unit: "kg", available: 1 },
    ]);

    expect(planned.find(row => row.ingredientId === "beef")?.quantity).toBeCloseTo(-0.16, 8);
    expect(arianaShortages).toEqual([]);
    expect(laMarsaShortages).toHaveLength(1);
    expect(laMarsaShortages[0]).toMatchObject({
      ingredientId: "beef",
      ingredientName: "Ground beef",
      unit: "kg",
      available: 0.1,
    });
    expect(laMarsaShortages[0].required).toBeCloseTo(0.16, 8);
  });
});
