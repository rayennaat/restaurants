import { describe, expect, it } from "vitest";
import {
  canTransition,
  describeShortfalls,
  findMissingIngredients,
  findShortfalls,
  isEditableTransfer,
  isInTransit,
  isTerminalTransfer,
  prepareTransferLines,
  transferValueMillis,
  TRANSFER_STATUSES,
  type TransferIngredient,
} from "@/lib/transfers";
import { createTransferInput } from "@/lib/validation";
import { hasPermission, MEMBER_ROLES, type MemberRole } from "@/lib/permissions";
import type { UnitRow } from "@/lib/units";

/**
 * Transfer rules.
 *
 * These decide whether stock physically moves between two sites, so the cases
 * worth pinning are the ones that would quietly create or destroy inventory: a
 * unit converted wrongly, a shortfall not noticed, a transfer to itself netting
 * to zero. Each is asserted directly against the pure functions.
 */

const UNITS: UnitRow[] = [
  { code: "kg", name: "Kilogram", dimension: "mass", multiplierToBase: "1", isBase: true },
  { code: "g", name: "Gram", dimension: "mass", multiplierToBase: "0.001", isBase: false },
  { code: "unit", name: "Unit", dimension: "count", multiplierToBase: "1", isBase: true },
  { code: "dozen", name: "Dozen", dimension: "count", multiplierToBase: "12", isBase: false },
];

const BEEF: TransferIngredient = { id: "beef", name: "Beef", baseUnitCode: "kg", unitCostMillis: 30_000 };
const CUCUMBER: TransferIngredient = { id: "cucumber", name: "Cucumber", baseUnitCode: "kg", unitCostMillis: 2_000 };
const EGGS: TransferIngredient = { id: "eggs", name: "Eggs", baseUnitCode: "unit", unitCostMillis: 400 };
const CATALOG = [BEEF, CUCUMBER, EGGS];

const uuid = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

// ------------------------------------------------------------- unit handling

describe("unit conversion", () => {
  it("keeps a quantity already in the base unit", () => {
    const [line] = prepareTransferLines([{ ingredientId: "beef", quantity: 10, unitCode: "kg" }], CATALOG, UNITS);
    expect(line.baseQuantity).toBe(10);
  });

  it("converts grams into kilograms", () => {
    const [line] = prepareTransferLines([{ ingredientId: "beef", quantity: 1500, unitCode: "g" }], CATALOG, UNITS);
    expect(line.baseQuantity).toBeCloseTo(1.5, 10);
  });

  it("converts dozens into units", () => {
    // The brief's example: 30 units of eggs, expressible as 2.5 dozen.
    const [line] = prepareTransferLines([{ ingredientId: "eggs", quantity: 2.5, unitCode: "dozen" }], CATALOG, UNITS);
    expect(line.baseQuantity).toBe(30);
  });

  it("defaults to the ingredient's base unit when none is given", () => {
    const [line] = prepareTransferLines([{ ingredientId: "eggs", quantity: 30 }], CATALOG, UNITS);
    expect(line.unitCode).toBe("unit");
    expect(line.baseQuantity).toBe(30);
  });

  it("records what the user typed alongside the converted figure", () => {
    // The document should read back the way it was written; the ledger stays in
    // one canonical unit.
    const [line] = prepareTransferLines([{ ingredientId: "beef", quantity: 500, unitCode: "g" }], CATALOG, UNITS);
    expect(line.quantity).toBe(500);
    expect(line.unitCode).toBe("g");
    expect(line.baseQuantity).toBeCloseTo(0.5, 10);
  });

  it("falls back to 1:1 across mismatched dimensions rather than zeroing stock", () => {
    // Matches `toBaseQuantity`: a nonsensical unit must never silently empty a
    // shelf. The value passes through untouched.
    const [line] = prepareTransferLines([{ ingredientId: "beef", quantity: 3, unitCode: "unit" }], CATALOG, UNITS);
    expect(line.baseQuantity).toBe(3);
  });

  it("values the line at the snapshotted cost per base unit", () => {
    const [line] = prepareTransferLines([{ ingredientId: "beef", quantity: 2, unitCode: "kg" }], CATALOG, UNITS);
    expect(line.valueMillis).toBe(60_000);
  });

  it("values a converted line correctly", () => {
    const [line] = prepareTransferLines([{ ingredientId: "beef", quantity: 500, unitCode: "g" }], CATALOG, UNITS);
    expect(line.valueMillis).toBe(15_000); // 0.5 kg × 30.000
  });

  it("totals a multi-line transfer", () => {
    const lines = prepareTransferLines(
      [
        { ingredientId: "beef", quantity: 10, unitCode: "kg" },
        { ingredientId: "cucumber", quantity: 5, unitCode: "kg" },
        { ingredientId: "eggs", quantity: 30, unitCode: "unit" },
      ],
      CATALOG,
      UNITS,
    );
    // The brief's example, priced: 300.000 + 10.000 + 12.000
    expect(transferValueMillis(lines)).toBe(322_000);
  });

  it("preserves the order lines were entered in", () => {
    const lines = prepareTransferLines(
      [{ ingredientId: "eggs", quantity: 1 }, { ingredientId: "beef", quantity: 1 }],
      CATALOG,
      UNITS,
    );
    expect(lines.map(line => line.sortOrder)).toEqual([0, 1]);
    expect(lines[0].ingredientId).toBe("eggs");
  });
});

// -------------------------------------------------------- unknown ingredients

describe("ingredients outside the catalog", () => {
  it("reports every unknown id rather than stopping at the first", () => {
    const missing = findMissingIngredients(
      [{ ingredientId: "beef", quantity: 1 }, { ingredientId: "ghost", quantity: 1 }, { ingredientId: "phantom", quantity: 1 }],
      CATALOG,
    );
    expect(missing.sort()).toEqual(["ghost", "phantom"]);
  });

  it("reports nothing when every id resolves", () => {
    expect(findMissingIngredients([{ ingredientId: "beef", quantity: 1 }], CATALOG)).toEqual([]);
  });

  it("treats an ingredient from another tenant as missing", () => {
    // The catalog is loaded scoped to one organization, so a foreign id is
    // simply absent — the cross-tenant check and the existence check are one.
    expect(findMissingIngredients([{ ingredientId: "beef-of-other-org", quantity: 1 }], CATALOG)).toEqual([
      "beef-of-other-org",
    ]);
  });

  it("refuses to prepare a line it cannot resolve", () => {
    expect(() => prepareTransferLines([{ ingredientId: "ghost", quantity: 1 }], CATALOG, UNITS)).toThrow(/Unknown ingredient/);
  });

  it("does not report the same unknown id twice", () => {
    const missing = findMissingIngredients(
      [{ ingredientId: "ghost", quantity: 1 }, { ingredientId: "ghost", quantity: 2 }],
      CATALOG,
    );
    expect(missing).toEqual(["ghost"]);
  });
});

// ---------------------------------------------------------- insufficient stock

describe("insufficient stock", () => {
  const lines = prepareTransferLines([{ ingredientId: "beef", quantity: 10, unitCode: "kg" }], CATALOG, UNITS);

  it("flags a line asking for more than the source holds", () => {
    // The brief's case: 5 kg available, 10 kg requested.
    const shortfalls = findShortfalls(lines, new Map([["beef", 5]]));
    expect(shortfalls).toHaveLength(1);
    expect(shortfalls[0]).toMatchObject({ available: 5, requested: 10, shortBy: 5 });
  });

  it("passes a line the source can cover exactly", () => {
    expect(findShortfalls(lines, new Map([["beef", 10]]))).toEqual([]);
  });

  it("passes a line with stock to spare", () => {
    expect(findShortfalls(lines, new Map([["beef", 25]]))).toEqual([]);
  });

  it("treats an ingredient with no movements at the source as zero", () => {
    const shortfalls = findShortfalls(lines, new Map());
    expect(shortfalls[0]).toMatchObject({ available: 0, shortBy: 10 });
  });

  it("treats a negative balance as nothing available", () => {
    const shortfalls = findShortfalls(lines, new Map([["beef", -2]]));
    expect(shortfalls[0].shortBy).toBe(12);
  });

  it("tolerates float noise from unit conversion", () => {
    // 999.9999999 g of a 1 kg holding is not a real shortfall; reporting it
    // would block a legitimate transfer over a rounding artifact.
    const grams = prepareTransferLines([{ ingredientId: "beef", quantity: 1000, unitCode: "g" }], CATALOG, UNITS);
    expect(findShortfalls(grams, new Map([["beef", 1]]))).toEqual([]);
  });

  it("checks each ingredient independently", () => {
    const multi = prepareTransferLines(
      [{ ingredientId: "beef", quantity: 10 }, { ingredientId: "cucumber", quantity: 5 }],
      CATALOG,
      UNITS,
    );
    const shortfalls = findShortfalls(multi, new Map([["beef", 100], ["cucumber", 1]]));
    expect(shortfalls.map(entry => entry.ingredientId)).toEqual(["cucumber"]);
  });

  it("reports a shortfall once even if an ingredient somehow appears twice", () => {
    const duplicated = prepareTransferLines(
      [{ ingredientId: "beef", quantity: 6 }, { ingredientId: "beef", quantity: 6 }],
      CATALOG,
      UNITS,
    );
    const shortfalls = findShortfalls(duplicated, new Map([["beef", 10]]));
    expect(shortfalls).toHaveLength(1);
    // Summed: 12 requested against 10 available.
    expect(shortfalls[0].requested).toBe(12);
  });

  it("explains the shortfall in terms the user can act on", () => {
    const message = describeShortfalls(findShortfalls(lines, new Map([["beef", 5]])));
    expect(message).toContain("Beef");
    expect(message).toContain("10");
    expect(message).toContain("5");
  });
});

// ------------------------------------------------------------- status rules

describe("the transfer lifecycle", () => {
  it("has exactly the four states the schema defines", () => {
    expect([...TRANSFER_STATUSES]).toEqual(["draft", "sent", "received", "cancelled"]);
  });

  it("allows a draft to be sent or cancelled", () => {
    expect(canTransition("draft", "sent")).toBe(true);
    expect(canTransition("draft", "cancelled")).toBe(true);
  });

  it("allows a sent transfer to be received or cancelled", () => {
    // A van turned back at the gate is a real event.
    expect(canTransition("sent", "received")).toBe(true);
    expect(canTransition("sent", "cancelled")).toBe(true);
  });

  it("never allows receiving a draft — stock must leave before it can arrive", () => {
    expect(canTransition("draft", "received")).toBe(false);
  });

  it("treats received and cancelled as terminal", () => {
    for (const status of ["received", "cancelled"] as const) {
      expect(isTerminalTransfer(status)).toBe(true);
      for (const target of TRANSFER_STATUSES) {
        expect(canTransition(status, target)).toBe(false);
      }
    }
  });

  it("never allows re-receiving a received transfer", () => {
    // Duplicate receive protection, stated at the domain level. The database
    // conditional UPDATE is what enforces it against a race.
    expect(canTransition("received", "received")).toBe(false);
  });

  it("only a draft is editable", () => {
    expect(isEditableTransfer("draft")).toBe(true);
    for (const status of ["sent", "received", "cancelled"] as const) {
      expect(isEditableTransfer(status)).toBe(false);
    }
  });

  it("only a sent transfer counts as in transit", () => {
    expect(isInTransit("sent")).toBe(true);
    expect(isInTransit("draft")).toBe(false);
    expect(isInTransit("received")).toBe(false);
  });
});

// -------------------------------------------------------------- validation

describe("validating a new transfer", () => {
  const valid = {
    sourceLocationId: uuid(1),
    destinationLocationId: uuid(2),
    items: [{ ingredientId: uuid(3), quantity: 10, unitCode: "kg" }],
  };

  it("accepts a well-formed transfer", () => {
    expect(createTransferInput.safeParse(valid).success).toBe(true);
  });

  it("rejects a transfer to the same location", () => {
    // Would post a matching − and + that net to zero: it would look like it
    // worked while moving nothing.
    const result = createTransferInput.safeParse({ ...valid, destinationLocationId: valid.sourceLocationId });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue => issue.path.includes("destinationLocationId"))).toBe(true);
    }
  });

  it("rejects a negative quantity", () => {
    expect(createTransferInput.safeParse({ ...valid, items: [{ ...valid.items[0], quantity: -5 }] }).success).toBe(false);
  });

  it("rejects a zero quantity", () => {
    expect(createTransferInput.safeParse({ ...valid, items: [{ ...valid.items[0], quantity: 0 }] }).success).toBe(false);
  });

  it("rejects a transfer with no lines", () => {
    expect(createTransferInput.safeParse({ ...valid, items: [] }).success).toBe(false);
  });

  it("rejects the same ingredient twice", () => {
    // Two lines for beef are two answers to "how much beef is moving".
    const result = createTransferInput.safeParse({
      ...valid,
      items: [
        { ingredientId: uuid(3), quantity: 1 },
        { ingredientId: uuid(3), quantity: 2 },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed location id", () => {
    expect(createTransferInput.safeParse({ ...valid, sourceLocationId: "not-a-uuid" }).success).toBe(false);
  });

  it("defaults to saving a draft rather than sending", () => {
    // Sending moves stock, so it must be asked for explicitly.
    const result = createTransferInput.parse(valid);
    expect(result.sendNow).toBe(false);
  });

  it("accepts an explicit send", () => {
    expect(createTransferInput.parse({ ...valid, sendNow: true }).sendNow).toBe(true);
  });

  it("allows a fractional quantity", () => {
    expect(createTransferInput.safeParse({ ...valid, items: [{ ...valid.items[0], quantity: 0.5 }] }).success).toBe(true);
  });
});

// -------------------------------------------------------------- permissions

describe("who may move stock between locations", () => {
  // No new roles were introduced: sending and receiving reuse
  // `record_operations`, and cancelling a dispatched transfer reuses
  // `manage_stock_counts`.
  const CAN_MOVE: MemberRole[] = ["owner", "manager", "inventory", "kitchen"];
  const CAN_CANCEL: MemberRole[] = ["owner", "manager", "inventory"];

  for (const role of MEMBER_ROLES) {
    it(`${role} ${CAN_MOVE.includes(role) ? "may" : "may not"} create, send or receive a transfer`, () => {
      expect(hasPermission(role, "record_operations")).toBe(CAN_MOVE.includes(role));
    });
  }

  for (const role of MEMBER_ROLES) {
    it(`${role} ${CAN_CANCEL.includes(role) ? "may" : "may not"} cancel a dispatched transfer`, () => {
      expect(hasPermission(role, "manage_stock_counts")).toBe(CAN_CANCEL.includes(role));
    });
  }

  it("keeps the accountant read-only here as everywhere", () => {
    expect(hasPermission("accountant", "record_operations")).toBe(false);
    expect(hasPermission("accountant", "manage_stock_counts")).toBe(false);
  });

  it("lets kitchen staff move stock but not reverse a dispatched transfer", () => {
    // Reversing stock that has already left is a supervisory correction.
    expect(hasPermission("kitchen", "record_operations")).toBe(true);
    expect(hasPermission("kitchen", "manage_stock_counts")).toBe(false);
  });
});
