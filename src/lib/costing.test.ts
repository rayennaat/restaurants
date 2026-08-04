import { describe, expect, it } from "vitest";
import { calculateMargin, calculateRecipeCost, convertToBaseUnit } from "./costing";

describe("costing engine", () => {
  it("calculates recipe cost", () => expect(calculateRecipeCost([{ quantityInBaseUnit: 0.15, unitCostMillis: 18000 }, { quantityInBaseUnit: 1, unitCostMillis: 700 }])).toBe(3400));
  it("calculates gross margin", () => expect(calculateMargin(15000, 6000)).toBe(60));
  it("converts units", () => expect(convertToBaseUnit(2.5, 1000)).toBe(2500));
});
