import { describe, expect, it } from "vitest";
import {
  calculateTheoreticalConsumption,
  countUnmappedSales,
  expandMenuItemConsumption,
  type MenuItemRequirement,
} from "@/lib/consumption";
import type { MenuGraphNode, RecipeGraphNode } from "@/lib/costing";
import type { UnitRow } from "@/lib/units";

/**
 * The units the app seeds for every organization. Consumption converts grams to
 * kilograms exactly as costing does, so these tests use the real table rather
 * than a simplified stand-in.
 */
const UNITS: UnitRow[] = [
  { code: "kg", name: "Kilogram", dimension: "mass", multiplierToBase: "1", isBase: true },
  { code: "g", name: "Gram", dimension: "mass", multiplierToBase: "0.001", isBase: false },
  { code: "l", name: "Litre", dimension: "volume", multiplierToBase: "1", isBase: true },
  { code: "ml", name: "Millilitre", dimension: "volume", multiplierToBase: "0.001", isBase: false },
  { code: "unit", name: "Unit", dimension: "count", multiplierToBase: "1", isBase: true },
];

const ingredientLine = (
  ingredientId: string,
  ingredientName: string,
  quantity: number,
  unitCode: string,
  baseUnitCode: string,
  unitCostMillis = 0,
) => ({ kind: "ingredient" as const, ingredientId, ingredientName, quantity, unitCode, baseUnitCode, unitCostMillis });

const recipeLine = (componentRecipeId: string, componentName: string, quantity: number, unitCode: string | null) => ({
  kind: "recipe" as const,
  componentRecipeId,
  componentName,
  quantity,
  unitCode,
});

describe("the worked example from the specification", () => {
  // Hamburger: 150 g beef, 50 g cucumber, 1 bun. Sell 10.
  const hamburger: MenuGraphNode = {
    id: "burger",
    name: "Hamburger",
    yieldQuantity: 1,
    lines: [
      ingredientLine("beef", "Beef", 150, "g", "kg", 18_000),
      ingredientLine("cucumber", "Cucumber", 50, "g", "kg", 2_000),
      ingredientLine("bun", "Bun", 1, "unit", "unit", 750),
    ],
  };

  it("converts grams to the ingredient base unit per portion", () => {
    const requirements = expandMenuItemConsumption([hamburger], [], UNITS).get("burger")!;
    const beef = requirements.find(entry => entry.ingredientId === "beef")!;

    expect(beef.quantityPerUnit).toBeCloseTo(0.15);
    expect(beef.baseUnitCode).toBe("kg");
  });

  it("reports 1.5 kg beef, 0.5 kg cucumber and 10 buns for 10 hamburgers", () => {
    const requirements = expandMenuItemConsumption([hamburger], [], UNITS);
    const consumption = calculateTheoreticalConsumption([{ menuItemId: "burger", quantity: 10 }], requirements);

    const byId = new Map(consumption.map(row => [row.ingredientId, row]));
    expect(byId.get("beef")!.quantity).toBeCloseTo(1.5);
    expect(byId.get("cucumber")!.quantity).toBeCloseTo(0.5);
    expect(byId.get("bun")!.quantity).toBeCloseTo(10);
  });

  it("values consumption at current ingredient cost", () => {
    const requirements = expandMenuItemConsumption([hamburger], [], UNITS);
    const consumption = calculateTheoreticalConsumption([{ menuItemId: "burger", quantity: 10 }], requirements);
    const byId = new Map(consumption.map(row => [row.ingredientId, row]));

    expect(byId.get("beef")!.costMillis).toBe(27_000); // 1.5 kg × 18.000
    expect(byId.get("cucumber")!.costMillis).toBe(1_000); // 0.5 kg × 2.000
    expect(byId.get("bun")!.costMillis).toBe(7_500); // 10 × 0.750
  });

  it("orders by cost so the expensive ingredients lead", () => {
    const requirements = expandMenuItemConsumption([hamburger], [], UNITS);
    const consumption = calculateTheoreticalConsumption([{ menuItemId: "burger", quantity: 10 }], requirements);
    expect(consumption.map(row => row.ingredientId)).toEqual(["beef", "bun", "cucumber"]);
  });
});
// CHUNK_TWO_HERE
describe("preparations", () => {
  // Mayonnaise: a 1 kg batch from 200 g egg yolk and 800 ml oil.
  const mayonnaise: RecipeGraphNode = {
    id: "mayo",
    name: "Mayonnaise",
    yieldQuantity: 1,
    yieldUnitCode: "kg",
    lines: [
      ingredientLine("yolk", "Egg yolk", 200, "g", "kg", 12_000),
      ingredientLine("oil", "Oil", 800, "ml", "l", 5_000),
    ],
  };

  const burgerWithSauce: MenuGraphNode = {
    id: "burger",
    name: "Burger",
    yieldQuantity: 1,
    lines: [ingredientLine("bun", "Bun", 1, "unit", "unit", 750), recipeLine("mayo", "Mayonnaise", 15, "g")],
  };

  it("reaches ingredients that exist only inside a preparation", () => {
    const requirements = expandMenuItemConsumption([burgerWithSauce], [mayonnaise], UNITS).get("burger")!;
    const ids = requirements.map(entry => entry.ingredientId).sort();
    expect(ids).toEqual(["bun", "oil", "yolk"]);
  });

  it("scales a preparation's inputs by the fraction of a batch used", () => {
    // 15 g of a 1 kg batch is 1.5%. That batch holds 0.2 kg yolk, so one burger
    // needs 0.003 kg.
    const requirements = expandMenuItemConsumption([burgerWithSauce], [mayonnaise], UNITS).get("burger")!;
    const yolk = requirements.find(entry => entry.ingredientId === "yolk")!;
    expect(yolk.quantityPerUnit).toBeCloseTo(0.003, 6);

    const consumption = calculateTheoreticalConsumption(
      [{ menuItemId: "burger", quantity: 100 }],
      expandMenuItemConsumption([burgerWithSauce], [mayonnaise], UNITS),
    );
    expect(consumption.find(row => row.ingredientId === "yolk")!.quantity).toBeCloseTo(0.3, 6);
  });

  it("divides a multi-portion batch down to one portion", () => {
    const bigBatch: RecipeGraphNode = { ...mayonnaise, yieldQuantity: 4 };
    const requirements = expandMenuItemConsumption([burgerWithSauce], [bigBatch], UNITS).get("burger")!;
    expect(requirements.find(entry => entry.ingredientId === "yolk")!.quantityPerUnit).toBeCloseTo(0.00075, 8);
  });

  it("resolves a preparation nested inside another preparation", () => {
    const garlicOil: RecipeGraphNode = {
      id: "garlic-oil",
      name: "Garlic oil",
      yieldQuantity: 1,
      yieldUnitCode: "l",
      lines: [ingredientLine("garlic", "Garlic", 100, "g", "kg", 8_000)],
    };
    const aioli: RecipeGraphNode = {
      id: "aioli",
      name: "Aioli",
      yieldQuantity: 1,
      yieldUnitCode: "kg",
      lines: [recipeLine("garlic-oil", "Garlic oil", 500, "ml")],
    };
    const dish: MenuGraphNode = {
      id: "dish",
      name: "Dish",
      yieldQuantity: 1,
      lines: [recipeLine("aioli", "Aioli", 100, "g")],
    };

    const requirements = expandMenuItemConsumption([dish], [aioli, garlicOil], UNITS).get("dish")!;
    // 100 g aioli = 0.1 batch; that batch holds 0.5 l garlic oil; which holds
    // 0.1 kg garlic per litre → 0.1 × 0.5 × 0.1 = 0.005 kg.
    expect(requirements.find(entry => entry.ingredientId === "garlic")!.quantityPerUnit).toBeCloseTo(0.005, 8);
  });

  it("sums an ingredient that arrives by two different paths", () => {
    const sauce: RecipeGraphNode = {
      id: "sauce",
      name: "Sauce",
      yieldQuantity: 1,
      yieldUnitCode: "kg",
      lines: [ingredientLine("onion", "Onion", 500, "g", "kg", 3_000)],
    };
    const dish: MenuGraphNode = {
      id: "dish",
      name: "Dish",
      yieldQuantity: 1,
      lines: [ingredientLine("onion", "Onion", 20, "g", "kg", 3_000), recipeLine("sauce", "Sauce", 100, "g")],
    };

    const requirements = expandMenuItemConsumption([dish], [sauce], UNITS).get("dish")!;
    const onionRows = requirements.filter(entry => entry.ingredientId === "onion");
    expect(onionRows).toHaveLength(1);
    // 20 g direct + 100 g of a batch that is half onion = 0.02 + 0.05
    expect(onionRows[0].quantityPerUnit).toBeCloseTo(0.07, 6);
  });
});

describe("multi-portion menu items", () => {
  it("divides a composition that yields several plates", () => {
    const sharingPlatter: MenuGraphNode = {
      id: "platter",
      name: "Platter",
      yieldQuantity: 4,
      lines: [ingredientLine("cheese", "Cheese", 800, "g", "kg", 20_000)],
    };

    const requirements = expandMenuItemConsumption([sharingPlatter], [], UNITS);
    expect(requirements.get("platter")![0].quantityPerUnit).toBeCloseTo(0.2);

    const consumption = calculateTheoreticalConsumption([{ menuItemId: "platter", quantity: 4 }], requirements);
    expect(consumption[0].quantity).toBeCloseTo(0.8);
  });
});
describe("aggregation across a period", () => {
  const burger: MenuGraphNode = {
    id: "burger",
    name: "Burger",
    yieldQuantity: 1,
    lines: [ingredientLine("beef", "Beef", 150, "g", "kg", 18_000)],
  };
  const steak: MenuGraphNode = {
    id: "steak",
    name: "Steak",
    yieldQuantity: 1,
    lines: [ingredientLine("beef", "Beef", 250, "g", "kg", 18_000)],
  };

  it("combines the same ingredient across different dishes", () => {
    const requirements = expandMenuItemConsumption([burger, steak], [], UNITS);
    const consumption = calculateTheoreticalConsumption(
      [
        { menuItemId: "burger", quantity: 10 }, // 1.5 kg
        { menuItemId: "steak", quantity: 4 }, // 1.0 kg
      ],
      requirements,
    );

    expect(consumption).toHaveLength(1);
    expect(consumption[0].quantity).toBeCloseTo(2.5);
  });

  it("ignores zero and negative sold quantities", () => {
    const requirements = expandMenuItemConsumption([burger], [], UNITS);
    expect(calculateTheoreticalConsumption([{ menuItemId: "burger", quantity: 0 }], requirements)).toEqual([]);
    expect(calculateTheoreticalConsumption([{ menuItemId: "burger", quantity: -5 }], requirements)).toEqual([]);
  });

  it("rounds cost once at the end rather than per line", () => {
    // A per-line round would drift over many small lines; one final round does not.
    const cheap: MenuGraphNode = {
      id: "cheap",
      name: "Cheap",
      yieldQuantity: 1,
      lines: [ingredientLine("spice", "Spice", 1, "g", "kg", 3_333)],
    };
    const requirements = expandMenuItemConsumption([cheap], [], UNITS);
    const consumption = calculateTheoreticalConsumption([{ menuItemId: "cheap", quantity: 3 }], requirements);

    expect(consumption[0].costMillis).toBe(10); // 3 × 0.001 kg × 3333 = 9.999
    expect(Number.isInteger(consumption[0].costMillis)).toBe(true);
  });
});

describe("dishes that cannot be expanded", () => {
  it("contributes nothing for a dish with no composition", () => {
    const empty: MenuGraphNode = { id: "mystery", name: "Mystery", yieldQuantity: 1, lines: [] };
    const requirements = expandMenuItemConsumption([empty], [], UNITS);
    expect(calculateTheoreticalConsumption([{ menuItemId: "mystery", quantity: 50 }], requirements)).toEqual([]);
  });

  it("contributes nothing for a menu item that no longer exists", () => {
    const requirements = new Map<string, MenuItemRequirement[]>();
    expect(calculateTheoreticalConsumption([{ menuItemId: "deleted", quantity: 3 }], requirements)).toEqual([]);
  });

  it("reports unmapped sales so a small figure is explained rather than trusted", () => {
    const burger: MenuGraphNode = {
      id: "burger",
      name: "Burger",
      yieldQuantity: 1,
      lines: [ingredientLine("beef", "Beef", 150, "g", "kg", 18_000)],
    };
    const empty: MenuGraphNode = { id: "mystery", name: "Mystery", yieldQuantity: 1, lines: [] };
    const requirements = expandMenuItemConsumption([burger, empty], [], UNITS);

    const unmapped = countUnmappedSales(
      [
        { menuItemId: "burger", quantity: 10 },
        { menuItemId: "mystery", quantity: 7 },
        { menuItemId: "gone", quantity: 2 },
      ],
      requirements,
    );

    expect(unmapped.units).toBe(9);
    expect(unmapped.menuItemIds.sort()).toEqual(["gone", "mystery"]);
  });
});

describe("malformed graphs do not hang or explode", () => {
  it("survives a preparation cycle by contributing nothing", () => {
    // costRecipeGraph surfaces the cycle path to the user; here it is enough
    // that the walk terminates instead of recursing forever.
    const a: RecipeGraphNode = {
      id: "a",
      name: "A",
      yieldQuantity: 1,
      yieldUnitCode: "kg",
      lines: [recipeLine("b", "B", 1, "kg")],
    };
    const b: RecipeGraphNode = {
      id: "b",
      name: "B",
      yieldQuantity: 1,
      yieldUnitCode: "kg",
      lines: [recipeLine("a", "A", 1, "kg")],
    };
    const dish: MenuGraphNode = { id: "dish", name: "Dish", yieldQuantity: 1, lines: [recipeLine("a", "A", 1, "kg")] };

    const requirements = expandMenuItemConsumption([dish], [a, b], UNITS);
    expect(requirements.get("dish")).toEqual([]);
  });

  it("treats a zero yield as one portion instead of dividing by zero", () => {
    const broken: MenuGraphNode = {
      id: "broken",
      name: "Broken",
      yieldQuantity: 0,
      lines: [ingredientLine("beef", "Beef", 150, "g", "kg", 18_000)],
    };
    const requirements = expandMenuItemConsumption([broken], [], UNITS).get("broken")!;
    expect(Number.isFinite(requirements[0].quantityPerUnit)).toBe(true);
    expect(requirements[0].quantityPerUnit).toBeCloseTo(0.15);
  });

  it("falls back to a 1:1 conversion when a unit is unknown", () => {
    // Matches toBaseQuantity: a missing units row must never silently zero a
    // quantity, because that would understate consumption rather than error.
    const dish: MenuGraphNode = {
      id: "dish",
      name: "Dish",
      yieldQuantity: 1,
      lines: [ingredientLine("thing", "Thing", 3, "parsec", "kg", 1_000)],
    };
    const requirements = expandMenuItemConsumption([dish], [], UNITS).get("dish")!;
    expect(requirements[0].quantityPerUnit).toBe(3);
  });
});

describe("a preparation shared by many dishes", () => {
  it("expands once and applies everywhere", () => {
    const sauce: RecipeGraphNode = {
      id: "sauce",
      name: "Sauce",
      yieldQuantity: 1,
      yieldUnitCode: "kg",
      lines: [ingredientLine("tomato", "Tomato", 900, "g", "kg", 3_000)],
    };
    const dishes: MenuGraphNode[] = Array.from({ length: 5 }, (_, index) => ({
      id: `dish-${index}`,
      name: `Dish ${index}`,
      yieldQuantity: 1,
      lines: [recipeLine("sauce", "Sauce", 100, "g")],
    }));

    const requirements = expandMenuItemConsumption(dishes, [sauce], UNITS);
    for (const dish of dishes) {
      expect(requirements.get(dish.id)![0].quantityPerUnit).toBeCloseTo(0.09, 6);
    }

    const consumption = calculateTheoreticalConsumption(
      dishes.map(dish => ({ menuItemId: dish.id, quantity: 10 })),
      requirements,
    );
    expect(consumption[0].quantity).toBeCloseTo(4.5, 6);
  });
});
