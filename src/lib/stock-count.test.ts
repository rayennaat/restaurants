import { describe, expect, it } from "vitest";
import {
  adjustableItems,
  calculateItemVariance,
  isEditableStatus,
  isTerminalStatus,
  rankByVariance,
  summarizeCount,
  varianceTone,
  type CountItemInput,
} from "@/lib/stock-count";

const item = (overrides: Partial<CountItemInput> = {}): CountItemInput => ({
  ingredientId: "i1",
  ingredientName: "Chicken",
  unit: "kg",
  systemQuantity: 21,
  countedQuantity: 18,
  unitCostMillis: 18_000, // 18.000 TND per kg
  ...overrides,
});

describe("item variance", () => {
  it("prices the worked example from the spec", () => {
    // System 21 kg, counted 18 kg, 18 TND/kg -> -3 kg, -54 TND.
    const result = calculateItemVariance(item());
    expect(result.varianceQuantity).toBe(-3);
    expect(result.varianceValueMillis).toBe(-54_000);
    expect(result.variancePercent).toBeCloseTo(-14.2857, 3);
    expect(result.isCounted).toBe(true);
  });

  it("reports a surplus as a positive variance", () => {
    const result = calculateItemVariance(item({ systemQuantity: 10, countedQuantity: 12 }));
    expect(result.varianceQuantity).toBe(2);
    expect(result.varianceValueMillis).toBe(36_000);
    expect(result.variancePercent).toBeCloseTo(20);
  });

  it("treats an exact count as no variance", () => {
    const result = calculateItemVariance(item({ systemQuantity: 7, countedQuantity: 7 }));
    expect(result.varianceQuantity).toBe(0);
    expect(result.varianceValueMillis).toBe(0);
    expect(result.variancePercent).toBe(0);
  });

  it("distinguishes an uncounted line from one counted at zero", () => {
    const uncounted = calculateItemVariance(item({ countedQuantity: null }));
    expect(uncounted.isCounted).toBe(false);
    expect(uncounted.varianceQuantity).toBe(0);
    expect(uncounted.varianceValueMillis).toBe(0);

    // Counted as literally nothing on the shelf: the whole balance is missing.
    const emptyShelf = calculateItemVariance(item({ systemQuantity: 21, countedQuantity: 0 }));
    expect(emptyShelf.isCounted).toBe(true);
    expect(emptyShelf.varianceQuantity).toBe(-21);
    expect(emptyShelf.varianceValueMillis).toBe(-378_000);
  });

  it("returns no percentage when the ledger held nothing", () => {
    const found = calculateItemVariance(item({ systemQuantity: 0, countedQuantity: 5 }));
    expect(found.variancePercent).toBeNull();
    expect(found.varianceQuantity).toBe(5);
    expect(found.varianceValueMillis).toBe(90_000);
  });

  it("uses the magnitude of a negative system balance for the percentage", () => {
    // Negative stock is a data problem, but the percentage should still read
    // as a direction rather than flipping sign.
    const result = calculateItemVariance(item({ systemQuantity: -4, countedQuantity: 0 }));
    expect(result.varianceQuantity).toBe(4);
    expect(result.variancePercent).toBeCloseTo(100);
  });

  it("rounds money exactly once, never accumulating float error", () => {
    const result = calculateItemVariance(item({ systemQuantity: 1, countedQuantity: 0.7, unitCostMillis: 3_333 }));
    // -0.3 * 3333 = -999.9 -> -1000
    expect(Number.isInteger(result.varianceValueMillis)).toBe(true);
    expect(result.varianceValueMillis).toBe(-1000);
  });

  it("survives a non-finite counted value", () => {
    const result = calculateItemVariance(item({ countedQuantity: Number.NaN }));
    expect(result.isCounted).toBe(false);
    expect(result.varianceValueMillis).toBe(0);
  });
});

describe("count summary", () => {
  const priced = (items: CountItemInput[]) => items.map(calculateItemVariance);

  it("separates gains from losses instead of only netting them", () => {
    const summary = summarizeCount(
      priced([
        item({ ingredientId: "a", systemQuantity: 10, countedQuantity: 12, unitCostMillis: 170_000 }), // +340.000
        item({ ingredientId: "b", systemQuantity: 20, countedQuantity: 18, unitCostMillis: 290_000 }), // -580.000
      ]),
    );
    expect(summary.positiveValueMillis).toBe(340_000);
    expect(summary.negativeValueMillis).toBe(-580_000);
    expect(summary.netValueMillis).toBe(-240_000);
    // Net hides that 920.000 of stock moved in total.
    expect(summary.absoluteValueMillis).toBe(920_000);
  });

  it("counts only lines that actually differ as variances", () => {
    const summary = summarizeCount(
      priced([
        item({ ingredientId: "a", systemQuantity: 5, countedQuantity: 5 }),
        item({ ingredientId: "b", systemQuantity: 5, countedQuantity: 4 }),
        item({ ingredientId: "c", countedQuantity: null }),
      ]),
    );
    expect(summary.itemCount).toBe(3);
    expect(summary.countedCount).toBe(2);
    expect(summary.varianceCount).toBe(1);
    expect(summary.isComplete).toBe(false);
  });

  it("is complete only when every line has been counted", () => {
    expect(summarizeCount(priced([item(), item({ ingredientId: "b" })])).isComplete).toBe(true);
    expect(summarizeCount(priced([item(), item({ ingredientId: "b", countedQuantity: null })])).isComplete).toBe(false);
  });

  it("an empty sheet is not complete", () => {
    const summary = summarizeCount([]);
    expect(summary.isComplete).toBe(false);
    expect(summary.netValueMillis).toBe(0);
  });
});

describe("adjustments", () => {
  it("only emits movements for counted lines that differ", () => {
    const items = [
      item({ ingredientId: "a", systemQuantity: 5, countedQuantity: 5 }), // confirms ledger
      item({ ingredientId: "b", systemQuantity: 5, countedQuantity: 3 }), // -2
      item({ ingredientId: "c", countedQuantity: null }), // not counted
    ].map(calculateItemVariance);

    const adjustable = adjustableItems(items);
    expect(adjustable.map(entry => entry.ingredientId)).toEqual(["b"]);
    expect(adjustable[0].varianceQuantity).toBe(-2);
  });

  it("ranks the largest variances first regardless of direction", () => {
    const items = [
      item({ ingredientId: "small", systemQuantity: 10, countedQuantity: 9 }),
      item({ ingredientId: "big-loss", systemQuantity: 10, countedQuantity: 2 }),
      item({ ingredientId: "big-gain", systemQuantity: 10, countedQuantity: 16 }),
    ].map(calculateItemVariance);

    expect(rankByVariance(items).map(entry => entry.ingredientId)).toEqual(["big-loss", "big-gain", "small"]);
  });
});

describe("variance tone", () => {
  it("flags proportionally, not by cash value", () => {
    // 2 kg missing from 4 kg is a process failure...
    expect(varianceTone(calculateItemVariance(item({ systemQuantity: 4, countedQuantity: 2 })))).toBe("danger");
    // ...the same 2 kg from 400 kg is noise.
    expect(varianceTone(calculateItemVariance(item({ systemQuantity: 400, countedQuantity: 398 })))).toBe("neutral");
  });

  it("stays neutral for an exact or uncounted line", () => {
    expect(varianceTone(calculateItemVariance(item({ systemQuantity: 5, countedQuantity: 5 })))).toBe("neutral");
    expect(varianceTone(calculateItemVariance(item({ countedQuantity: null })))).toBe("neutral");
  });

  it("warns when no percentage can be formed", () => {
    expect(varianceTone(calculateItemVariance(item({ systemQuantity: 0, countedQuantity: 3 })))).toBe("warning");
  });
});

describe("status transitions", () => {
  it("only draft and counting are editable", () => {
    expect(isEditableStatus("draft")).toBe(true);
    expect(isEditableStatus("counting")).toBe(true);
    expect(isEditableStatus("submitted")).toBe(false);
    expect(isEditableStatus("approved")).toBe(false);
    expect(isEditableStatus("rejected")).toBe(false);
  });

  it("approved and rejected are terminal", () => {
    expect(isTerminalStatus("approved")).toBe(true);
    expect(isTerminalStatus("rejected")).toBe(true);
    expect(isTerminalStatus("submitted")).toBe(false);
  });
});
