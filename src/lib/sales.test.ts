import { describe, expect, it } from "vitest";
import {
  buildImportedSaleLines,
  buildSaleLines,
  findMissingMenuItems,
  SALE_SOURCES,
  SALE_STATUSES,
  totalUnitsSold,
  type PricedMenuItem,
} from "@/lib/sales";
import { hasPermission, MEMBER_ROLES, requirePermission, type MemberRole } from "@/lib/permissions";
import { recordSaleInput, voidSaleInput } from "@/lib/validation";

/**
 * Sales arithmetic and the contract around it.
 *
 * The stakes here are unusual for this codebase: a bug in costing shows a wrong
 * estimate, but a bug in this file misstates money that actually changed hands,
 * and the error is permanent — sale lines are immutable by database trigger.
 * So the historical-pricing guarantee is tested from several angles rather than
 * assumed from the fact that the code obviously snapshots a price.
 */

const BURGER: PricedMenuItem = { id: "burger", name: "Hamburger", sellingPriceMillis: 20_000 };
const FRIES: PricedMenuItem = { id: "fries", name: "Fries", sellingPriceMillis: 6_500 };
const CATALOG = [BURGER, FRIES];

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("sale line pricing", () => {
  it("prices a line from the catalog, not from the caller", () => {
    const { lines } = buildSaleLines([{ menuItemId: "burger", quantity: 3 }], CATALOG);

    expect(lines).toHaveLength(1);
    expect(lines[0].unitPriceMillis).toBe(20_000);
    expect(lines[0].lineTotalMillis).toBe(60_000);
  });

  it("snapshots the menu item name onto the line", () => {
    const { lines } = buildSaleLines([{ menuItemId: "burger", quantity: 1 }], CATALOG);
    expect(lines[0].menuItemName).toBe("Hamburger");
  });

  it("totals a multi-line sale", () => {
    const { lines, totalMillis } = buildSaleLines(
      [
        { menuItemId: "burger", quantity: 2 },
        { menuItemId: "fries", quantity: 3 },
      ],
      CATALOG,
    );

    expect(lines.map(line => line.lineTotalMillis)).toEqual([40_000, 19_500]);
    expect(totalMillis).toBe(59_500);
  });

  it("preserves entry order in sortOrder", () => {
    const { lines } = buildSaleLines(
      [
        { menuItemId: "fries", quantity: 1 },
        { menuItemId: "burger", quantity: 1 },
      ],
      CATALOG,
    );

    expect(lines.map(line => line.sortOrder)).toEqual([0, 1]);
    expect(lines.map(line => line.menuItemId)).toEqual(["fries", "burger"]);
  });

  it("keeps a repeated dish as two lines rather than merging it", () => {
    // A ticket that rang the same dish twice is a record of what happened.
    const { lines, totalMillis } = buildSaleLines(
      [
        { menuItemId: "burger", quantity: 1 },
        { menuItemId: "burger", quantity: 2 },
      ],
      CATALOG,
    );

    expect(lines).toHaveLength(2);
    expect(totalMillis).toBe(60_000);
  });

  it("handles fractional portions", () => {
    const { totalMillis } = buildSaleLines([{ menuItemId: "burger", quantity: 0.5 }], CATALOG);
    expect(totalMillis).toBe(10_000);
  });

  it("rounds each line exactly once, to an integer minor unit", () => {
    const oddlyPriced: PricedMenuItem = { id: "coffee", name: "Coffee", sellingPriceMillis: 3_333 };
    const { lines, totalMillis } = buildSaleLines([{ menuItemId: "coffee", quantity: 0.5 }], [oddlyPriced]);

    expect(lines[0].lineTotalMillis).toBe(1_667);
    expect(Number.isInteger(totalMillis)).toBe(true);
  });

  it("totals to exactly the sum of the printed lines", () => {
    // Summing unrounded products instead would be marginally more accurate and
    // visibly disagree with the receipt.
    const third: PricedMenuItem = { id: "third", name: "Third", sellingPriceMillis: 1_000 };
    const items = [
      { menuItemId: "third", quantity: 1 / 3 },
      { menuItemId: "third", quantity: 1 / 3 },
      { menuItemId: "third", quantity: 1 / 3 },
    ];
    const { lines, totalMillis } = buildSaleLines(items, [third]);

    expect(totalMillis).toBe(lines.reduce((sum, line) => sum + line.lineTotalMillis, 0));
    expect(totalMillis).toBe(999);
  });

  it("prices a free item at zero without failing", () => {
    const free: PricedMenuItem = { id: "water", name: "Tap water", sellingPriceMillis: 0 };
    const { totalMillis } = buildSaleLines([{ menuItemId: "water", quantity: 4 }], [free]);
    expect(totalMillis).toBe(0);
  });
});

describe("historical selling price", () => {
  it("does not move an old sale when the menu is re-priced", () => {
    // The specification's own example: a burger at 20 DT that later becomes 22.
    const january = buildSaleLines([{ menuItemId: "burger", quantity: 10 }], [BURGER]);

    const repriced: PricedMenuItem = { ...BURGER, sellingPriceMillis: 22_000 };
    const february = buildSaleLines([{ menuItemId: "burger", quantity: 10 }], [repriced]);

    // January's lines are values already produced; nothing recomputes them.
    expect(january.totalMillis).toBe(200_000);
    expect(february.totalMillis).toBe(220_000);
    expect(january.lines[0].unitPriceMillis).toBe(20_000);
  });

  it("keeps the name a dish sold under after it is renamed", () => {
    const before = buildSaleLines([{ menuItemId: "burger", quantity: 1 }], [BURGER]);
    const after = buildSaleLines([{ menuItemId: "burger", quantity: 1 }], [{ ...BURGER, name: "Classic Burger" }]);

    expect(before.lines[0].menuItemName).toBe("Hamburger");
    expect(after.lines[0].menuItemName).toBe("Classic Burger");
  });

  it("carries no reference back to the live catalog row", () => {
    // Mutating the catalog after the fact must not reach a built line — the
    // snapshot has to be a copy, not a pointer.
    const mutable: PricedMenuItem = { id: "burger", name: "Hamburger", sellingPriceMillis: 20_000 };
    const { lines } = buildSaleLines([{ menuItemId: "burger", quantity: 1 }], [mutable]);

    mutable.sellingPriceMillis = 99_000;
    mutable.name = "Renamed";

    expect(lines[0].unitPriceMillis).toBe(20_000);
    expect(lines[0].menuItemName).toBe("Hamburger");
    expect(lines[0].lineTotalMillis).toBe(20_000);
  });
});

describe("tenant isolation at the pricing boundary", () => {
  // The catalog handed to buildSaleLines is loaded scoped to one organization,
  // so a foreign id is indistinguishable from a nonexistent one — which is the
  // isolation guarantee, expressed as a lookup failure.
  it("reports an id the catalog does not contain", () => {
    expect(findMissingMenuItems([{ menuItemId: "other-tenant-dish", quantity: 1 }], CATALOG)).toEqual([
      "other-tenant-dish",
    ]);
  });

  it("reports every missing id, not just the first", () => {
    const missing = findMissingMenuItems(
      [
        { menuItemId: "ghost-a", quantity: 1 },
        { menuItemId: "burger", quantity: 1 },
        { menuItemId: "ghost-b", quantity: 1 },
      ],
      CATALOG,
    );

    expect(missing.sort()).toEqual(["ghost-a", "ghost-b"]);
  });

  it("deduplicates a missing id repeated across lines", () => {
    const missing = findMissingMenuItems(
      [
        { menuItemId: "ghost", quantity: 1 },
        { menuItemId: "ghost", quantity: 2 },
      ],
      CATALOG,
    );

    expect(missing).toEqual(["ghost"]);
  });

  it("finds nothing missing when every id resolves", () => {
    expect(findMissingMenuItems([{ menuItemId: "burger", quantity: 1 }], CATALOG)).toEqual([]);
  });

  it("refuses to invent a price for an unresolved item", () => {
    // Belt and braces: even if a caller skipped the missing-id check, pricing
    // must fail loudly rather than record a sale worth zero.
    expect(() => buildSaleLines([{ menuItemId: "other-tenant-dish", quantity: 1 }], CATALOG)).toThrow(
      /Unknown menu item/,
    );
  });
});

describe("units sold", () => {
  it("sums quantities across lines", () => {
    expect(
      totalUnitsSold([
        { menuItemId: "burger", quantity: 2 },
        { menuItemId: "fries", quantity: 3 },
      ]),
    ).toBe(5);
  });

  it("is zero for an empty sale", () => {
    expect(totalUnitsSold([])).toBe(0);
  });
});

describe("recorded sale input", () => {
  const valid = {
    locationId: uuid(1),
    source: "manual" as const,
    items: [{ menuItemId: uuid(2), quantity: 2 }],
  };

  it("accepts a minimal manual sale", () => {
    const parsed = recordSaleInput.parse(valid);
    expect(parsed.source).toBe("manual");
    expect(parsed.items).toHaveLength(1);
  });

  it("defaults the source to manual", () => {
    const { source, ...withoutSource } = valid;
    void source;
    expect(recordSaleInput.parse(withoutSource).source).toBe("manual");
  });

  it("rejects a sale with no lines", () => {
    expect(() => recordSaleInput.parse({ ...valid, items: [] })).toThrow();
  });

  it("rejects a zero or negative quantity", () => {
    expect(() => recordSaleInput.parse({ ...valid, items: [{ menuItemId: uuid(2), quantity: 0 }] })).toThrow();
    expect(() => recordSaleInput.parse({ ...valid, items: [{ menuItemId: uuid(2), quantity: -1 }] })).toThrow();
  });

  it("accepts a fractional quantity", () => {
    expect(recordSaleInput.parse({ ...valid, items: [{ menuItemId: uuid(2), quantity: 0.5 }] }).items[0].quantity).toBe(
      0.5,
    );
  });

  it("rejects a menu item id that is not a uuid", () => {
    expect(() => recordSaleInput.parse({ ...valid, items: [{ menuItemId: "burger", quantity: 1 }] })).toThrow();
  });

  it("rejects a location that is not a uuid", () => {
    expect(() => recordSaleInput.parse({ ...valid, locationId: "main" })).toThrow();
  });

  it("accepts no price from the client under any key", () => {
    // The server resolves price from its own catalog. A tampered request that
    // carries one must not be able to influence recorded revenue.
    const parsed = recordSaleInput.parse({
      ...valid,
      items: [{ menuItemId: uuid(2), quantity: 1, unitPriceMillis: 1, sellingPriceMillis: 1 }],
    });

    expect(parsed.items[0]).toEqual({ menuItemId: uuid(2), quantity: 1 });
  });

  it("accepts the import sources the next task will use", () => {
    for (const source of SALE_SOURCES) {
      expect(recordSaleInput.parse({ ...valid, source }).source).toBe(source);
    }
  });

  it("rejects an unknown source", () => {
    expect(() => recordSaleInput.parse({ ...valid, source: "square" })).toThrow();
  });

  it("parses an ISO timestamp for a backdated import", () => {
    const parsed = recordSaleInput.parse({ ...valid, soldAt: "2026-01-15T18:30:00.000Z" });
    expect(parsed.soldAt?.toISOString()).toBe("2026-01-15T18:30:00.000Z");
  });

  it("rejects a timestamp with no offset", () => {
    // An offsetless string would be read as the server's zone, silently moving
    // an imported sale across a day boundary.
    expect(() => recordSaleInput.parse({ ...valid, soldAt: "2026-01-15 18:30:00" })).toThrow();
  });

  it("leaves soldAt undefined when omitted, so the server stamps now", () => {
    expect(recordSaleInput.parse(valid).soldAt).toBeUndefined();
  });

  it("carries an external id for import idempotency", () => {
    expect(recordSaleInput.parse({ ...valid, externalId: "TICKET-4471" }).externalId).toBe("TICKET-4471");
  });

  it("caps the number of lines on one sale", () => {
    const tooMany = Array.from({ length: 201 }, () => ({ menuItemId: uuid(2), quantity: 1 }));
    expect(() => recordSaleInput.parse({ ...valid, items: tooMany })).toThrow();
  });
});

describe("void sale input", () => {
  it("requires a reason", () => {
    expect(() => voidSaleInput.parse({ saleId: uuid(3) })).toThrow();
    expect(() => voidSaleInput.parse({ saleId: uuid(3), reason: "" })).toThrow();
  });

  it("accepts a reason", () => {
    expect(voidSaleInput.parse({ saleId: uuid(3), reason: "Rung twice by mistake" }).reason).toBe(
      "Rung twice by mistake",
    );
  });
});

describe("who may manage sales", () => {
  // The full matrix lives in permissions.test.ts; these assert the intent
  // specific to revenue — narrower than general operations, and read-only for
  // the accountant who reports on it.
  const ALLOWED: MemberRole[] = ["owner", "manager"];

  for (const role of MEMBER_ROLES) {
    const allowed = ALLOWED.includes(role);
    it(`${role} ${allowed ? "may" : "may not"} record or void a sale`, () => {
      expect(hasPermission(role, "manage_sales")).toBe(allowed);
    });
  }

  it("lets an accountant read sales without being able to alter them", () => {
    expect(hasPermission("accountant", "manage_sales")).toBe(false);
  });

  it("throws for a role without the permission", () => {
    expect(() => requirePermission("kitchen", "manage_sales")).toThrow();
    expect(() => requirePermission("owner", "manage_sales")).not.toThrow();
  });
});

describe("sale status and source vocabularies", () => {
  it("matches the database enums in migration 0006", () => {
    expect([...SALE_SOURCES]).toEqual(["manual", "csv_import", "pos_import"]);
    expect([...SALE_STATUSES]).toEqual(["recorded", "voided"]);
  });
});

describe("pricing imported lines", () => {
  const line = (overrides: Partial<Parameters<typeof buildImportedSaleLines>[0][number]> = {}) => ({
    menuItemId: "burger",
    menuItemName: "Hamburger",
    quantity: 2,
    unitPriceMillis: 15_000,
    lineTotalMillis: 30_000,
    sortOrder: 0,
    ...overrides,
  });

  it("keeps the imported price rather than the menu price", () => {
    // The burger sells for 20.000 today. A ticket that sold it for 15.000 must
    // stay at 15.000 — this is the historical-pricing guarantee for imports.
    const { lines } = buildImportedSaleLines([line()], CATALOG);
    expect(lines[0].unitPriceMillis).toBe(15_000);
    expect(BURGER.sellingPriceMillis).toBe(20_000);
  });

  it("recomputes the line total from quantity and price", () => {
    // Not copied from the input: a file claiming a total that disagrees with
    // its own quantity × price must not be able to invent revenue.
    const { lines } = buildImportedSaleLines([line({ lineTotalMillis: 999_999 })], CATALOG);
    expect(lines[0].lineTotalMillis).toBe(30_000);
  });

  it("rounds the line total exactly once", () => {
    const { lines } = buildImportedSaleLines([line({ quantity: 0.333, unitPriceMillis: 10_000 })], CATALOG);
    expect(lines[0].lineTotalMillis).toBe(3_330);
    expect(Number.isInteger(lines[0].lineTotalMillis)).toBe(true);
  });

  it("totals from the already-rounded line totals", () => {
    // So the header figure always equals what the printed lines add up to.
    const { lines, totalMillis } = buildImportedSaleLines(
      [line({ quantity: 1, unitPriceMillis: 3_333 }), line({ quantity: 1, unitPriceMillis: 3_333, sortOrder: 1 })],
      CATALOG,
    );
    expect(totalMillis).toBe(lines.reduce((sum, entry) => sum + entry.lineTotalMillis, 0));
  });

  it("snapshots the catalog name, not the spelling in the file", () => {
    // A row matched through an alias carries the till's wording; receipts and
    // reports should show the dish as the workspace names it.
    const { lines } = buildImportedSaleLines([line({ menuItemName: "BURGER XL" })], CATALOG);
    expect(lines[0].menuItemName).toBe("Hamburger");
  });

  it("preserves the order lines were planned in", () => {
    const { lines } = buildImportedSaleLines(
      [line(), line({ menuItemId: "fries", menuItemName: "Fries", sortOrder: 1 })],
      CATALOG,
    );
    expect(lines.map(entry => entry.sortOrder)).toEqual([0, 1]);
    expect(lines[1].menuItemId).toBe("fries");
  });

  it("accepts a zero price, since a promotional line is real", () => {
    const { lines, totalMillis } = buildImportedSaleLines([line({ unitPriceMillis: 0 })], CATALOG);
    expect(lines[0].lineTotalMillis).toBe(0);
    expect(totalMillis).toBe(0);
  });

  it("refuses a menu item outside the catalog", () => {
    // The catalog is loaded scoped to one organization, so this is the tenant
    // check as much as a validation one.
    expect(() => buildImportedSaleLines([line({ menuItemId: "from-another-org" })], CATALOG)).toThrow(/Unknown menu item/);
  });

  it("totals nothing for an empty import", () => {
    expect(buildImportedSaleLines([], CATALOG)).toEqual({ lines: [], totalMillis: 0 });
  });

  it("agrees with the manual path when the price happens to match the menu", () => {
    // The two builders must not disagree about arithmetic; only about where the
    // price comes from.
    const imported = buildImportedSaleLines([line({ unitPriceMillis: BURGER.sellingPriceMillis })], CATALOG);
    const manual = buildSaleLines([{ menuItemId: "burger", quantity: 2 }], CATALOG);
    expect(imported.totalMillis).toBe(manual.totalMillis);
    expect(imported.lines[0].lineTotalMillis).toBe(manual.lines[0].lineTotalMillis);
  });
});
