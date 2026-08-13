import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "@/lib/csv";
import {
  buildErrorReport,
  buildImportPlan,
  buildSampleCsvRows,
  missingRequiredFields,
  parseImportDate,
  parseDecimal,
  parseQuantity,
  suggestMapping,
  rowsFromTable,
  type ColumnMapping,
} from "@/lib/sales-import";

/**
 * The import pipeline.
 *
 * These tests are the specification for the money-sensitive decisions: which
 * reading of an ambiguous date is used, how a decimal comma is understood, what
 * happens to a dish the menu does not contain, and how a re-uploaded file avoids
 * doubling revenue. Each is asserted directly against the pure planner, so a
 * regression shows up here rather than as a wrong figure on a P&L months later.
 */

const CATALOG = [
  { id: "menu-burger", name: "Hamburger", sellingPriceMillis: 18_000 },
  { id: "menu-fries", name: "Frites", sellingPriceMillis: 6_500 },
];

const LOCATIONS = [
  { id: "loc-main", name: "Main" },
  { id: "loc-annex", name: "Annex" },
];

const MAPPING: ColumnMapping = {
  soldAt: "Date",
  menuItem: "Item",
  quantity: "Qty",
  unitPrice: "Price",
};

/** Plans a CSV string with sensible defaults, so each test states only its variable. */
function plan(csv: string, overrides: Parameters<typeof buildImportPlan>[1] | Partial<Parameters<typeof buildImportPlan>[1]> = {}) {
  const table = parseCsv(csv);
  return buildImportPlan(rowsFromTable(table), {
    mapping: MAPPING,
    catalog: CATALOG,
    locations: LOCATIONS,
    defaultLocationId: "loc-main",
    currency: "TND",
    dateFormat: "auto",
    ...overrides,
  });
}

// --------------------------------------------------------------- value parsing

describe("parsing quantities", () => {
  it("reads a whole number", () => {
    expect(parseQuantity("3")).toBe(3);
  });

  it("reads a padded number", () => {
    expect(parseQuantity(" 12 ")).toBe(12);
  });

  it("rejects zero", () => {
    expect(parseQuantity("0")).toBeNull();
  });

  it("rejects a negative", () => {
    expect(parseQuantity("-2")).toBeNull();
  });

  it("accepts a fraction, matching manual entry and sales by weight", () => {
    // `saleLineInput` allows fractional quantities deliberately — a half
    // portion is real, and a till selling by weight exports 0.35.
    expect(parseQuantity("1.5")).toBe(1.5);
  });

  it("rejects text", () => {
    expect(parseQuantity("two")).toBeNull();
  });

  it("rejects blank", () => {
    expect(parseQuantity("")).toBeNull();
  });

  it("rejects a quantity beyond any plausible ticket", () => {
    expect(parseQuantity("99999999")).toBeNull();
  });
});

describe("parsing decimals", () => {
  it("reads a plain decimal point", () => {
    expect(parseDecimal("18.500")).toBe(18.5);
  });

  it("reads a decimal comma", () => {
    expect(parseDecimal("18,500")).toBe(18.5);
  });

  it("reads a thousands separator with a decimal point", () => {
    expect(parseDecimal("1,234.56")).toBe(1234.56);
  });

  it("reads European grouping with a decimal comma", () => {
    expect(parseDecimal("1.234,56")).toBe(1234.56);
  });

  it("reads space-grouped thousands", () => {
    expect(parseDecimal("1 234,56")).toBe(1234.56);
  });

  it("lets the currency decide a comma before three digits", () => {
    // Genuinely ambiguous from the string alone: "18,500" is 18.5 dinars on a
    // Tunisian till and 18500 on an American one. The currency's decimal places
    // settle it — dollars have no third decimal for those digits to occupy.
    expect(parseDecimal("18,500", 3)).toBe(18.5);
    expect(parseDecimal("1,500", 2)).toBe(1500);
  });

  it("treats a comma before two digits as a decimal", () => {
    expect(parseDecimal("18,50")).toBe(18.5);
  });

  it("strips a currency symbol", () => {
    expect(parseDecimal("$18.50")).toBe(18.5);
    expect(parseDecimal("18,500 DT")).toBe(18.5);
  });

  it("reads a parenthesised negative", () => {
    expect(parseDecimal("(18.50)")).toBe(-18.5);
  });

  it("rejects text and blanks", () => {
    expect(parseDecimal("n/a")).toBeNull();
    expect(parseDecimal("")).toBeNull();
  });
});

describe("parsing dates", () => {
  it("reads ISO with a time", () => {
    const date = parseImportDate("2025-12-31 23:30", "auto");
    expect(date?.getFullYear()).toBe(2025);
    expect(date?.getHours()).toBe(23);
  });

  it("keeps the restaurant's own clock rather than shifting to UTC", () => {
    // A till writing 23:30 means half past eleven where it stands. Parsing as
    // UTC would move a late ticket into the next day's takings.
    const date = parseImportDate("2025-12-31T23:30:00", "auto");
    expect(date?.getDate()).toBe(31);
    expect(date?.getHours()).toBe(23);
  });

  it("honours day-first when told", () => {
    const date = parseImportDate("03/04/2025", "dmy");
    expect(date?.getMonth()).toBe(3); // April
    expect(date?.getDate()).toBe(3);
  });

  it("honours month-first when told", () => {
    const date = parseImportDate("03/04/2025", "mdy");
    expect(date?.getMonth()).toBe(2); // March
    expect(date?.getDate()).toBe(4);
  });

  it("resolves the ambiguity itself when one reading is impossible", () => {
    const date = parseImportDate("25/12/2025", "auto");
    expect(date?.getMonth()).toBe(11);
    expect(date?.getDate()).toBe(25);
  });

  it("uses day-first for a genuinely ambiguous date under auto", () => {
    const date = parseImportDate("03/04/2025", "auto");
    expect(date?.getMonth()).toBe(3);
  });

  it("reads a two-digit year", () => {
    expect(parseImportDate("31/12/25", "dmy")?.getFullYear()).toBe(2025);
  });

  it("reads year-first with slashes", () => {
    const date = parseImportDate("2025/12/31", "ymd");
    expect(date?.getMonth()).toBe(11);
    expect(date?.getDate()).toBe(31);
  });

  it("reads a date with no time as midnight", () => {
    expect(parseImportDate("2025-06-15", "auto")?.getHours()).toBe(0);
  });

  it("reads 12-hour times with a meridiem", () => {
    expect(parseImportDate("2025-06-15 7:05 PM", "auto")?.getHours()).toBe(19);
    expect(parseImportDate("2025-06-15 12:30 AM", "auto")?.getHours()).toBe(0);
  });

  it("rejects an impossible day", () => {
    expect(parseImportDate("31/02/2025", "dmy")).toBeNull();
  });

  it("rejects a month above twelve in both orders", () => {
    expect(parseImportDate("13/13/2025", "auto")).toBeNull();
  });

  it("rejects text and blanks", () => {
    expect(parseImportDate("yesterday", "auto")).toBeNull();
    expect(parseImportDate("", "auto")).toBeNull();
  });
});

// ------------------------------------------------------------------- mapping

describe("mapping suggestions", () => {
  it("matches common English headings", () => {
    const mapping = suggestMapping(["Date", "Item", "Qty", "Unit Price", "Ticket"]);
    expect(mapping.soldAt).toBe("Date");
    expect(mapping.menuItem).toBe("Item");
    expect(mapping.quantity).toBe("Qty");
    expect(mapping.unitPrice).toBe("Unit Price");
    expect(mapping.reference).toBe("Ticket");
  });

  it("matches French headings, since the product ships in a French-speaking market", () => {
    const mapping = suggestMapping(["Date", "Produit", "Quantite", "Prix Unitaire"]);
    expect(mapping.menuItem).toBe("Produit");
    expect(mapping.quantity).toBe("Quantite");
    expect(mapping.unitPrice).toBe("Prix Unitaire");
  });

  it("ignores punctuation and case in headings", () => {
    expect(suggestMapping(["Order_Date"]).soldAt).toBe("Order_Date");
  });

  it("never assigns one column to two fields", () => {
    // "Price" feeding both unit price and line total would double-count money.
    const mapping = suggestMapping(["Date", "Item", "Qty", "Price"]);
    const used = Object.values(mapping).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
  });

  it("prefers an exact heading over another field's loose match", () => {
    const mapping = suggestMapping(["Date", "Item", "Qty", "Total", "Unit Price"]);
    expect(mapping.unitPrice).toBe("Unit Price");
    expect(mapping.lineTotal).toBe("Total");
  });

  it("leaves fields unset when nothing resembles them", () => {
    expect(suggestMapping(["col1", "col2"]).soldAt).toBeUndefined();
  });
});

describe("required fields", () => {
  it("names what is still missing", () => {
    expect(missingRequiredFields({ soldAt: "Date" })).toEqual(["menuItem", "quantity"]);
  });

  it("treats an explicit null as missing", () => {
    expect(missingRequiredFields({ soldAt: "Date", menuItem: null, quantity: "Qty" })).toEqual(["menuItem"]);
  });

  it("is satisfied without any optional field", () => {
    expect(missingRequiredFields({ soldAt: "D", menuItem: "I", quantity: "Q" })).toEqual([]);
  });
});

// ------------------------------------------------------------ a valid import

describe("a valid file", () => {
  const CSV = "Date,Item,Qty,Price\n2025-06-01 12:00,Hamburger,2,18.000\n2025-06-01 12:05,Frites,1,6.500";

  it("plans every row", () => {
    const result = plan(CSV);
    expect(result.stats.totalRows).toBe(2);
    expect(result.stats.importedRows).toBe(2);
    expect(result.stats.skippedRows).toBe(0);
  });

  it("resolves menu items by name", () => {
    const result = plan(CSV);
    expect(result.sales[0].lines[0].menuItemId).toBe("menu-burger");
  });

  it("converts prices to minor units", () => {
    const result = plan(CSV);
    expect(result.sales[0].lines[0].unitPriceMillis).toBe(18_000);
  });

  it("totals the value of the import", () => {
    // 2 × 18.000 + 1 × 6.500
    expect(plan(CSV).stats.totalMillis).toBe(42_500);
  });

  it("reports the period the file covers", () => {
    const result = plan(CSV);
    expect(result.period?.from.getHours()).toBe(12);
    expect(result.period?.to.getMinutes()).toBe(5);
  });

  it("matches names case- and accent-insensitively", () => {
    // A till writing "FRITES" or "frites" is the same dish as "Frites".
    const result = plan("Date,Item,Qty,Price\n2025-06-01,FRITES,1,6.500");
    expect(result.sales[0].lines[0].menuItemId).toBe("menu-fries");
  });

  it("assigns the chosen location to every row when the file names none", () => {
    const result = plan(CSV);
    expect(result.sales.every(sale => sale.locationId === "loc-main")).toBe(true);
  });
});

// --------------------------------------------------------- historical pricing

describe("historical prices", () => {
  it("keeps the price from the file rather than the current menu price", () => {
    // Requirement 9. The burger sells for 18.000 today; this ticket sold it for
    // 12.000 and must stay that way, or last year's margins silently rewrite.
    const result = plan("Date,Item,Qty,Price\n2024-01-01,Hamburger,1,12.000");
    expect(result.sales[0].lines[0].unitPriceMillis).toBe(12_000);
  });

  it("keeps a promotional price of zero", () => {
    const result = plan("Date,Item,Qty,Price\n2024-01-01,Hamburger,1,0");
    expect(result.sales[0].lines[0].unitPriceMillis).toBe(0);
    expect(result.rows[0].status).toBe("import");
  });

  it("derives the unit price from a line total when no unit price column exists", () => {
    const result = plan("Date,Item,Qty,Total\n2025-06-01,Hamburger,4,50.000", {
      mapping: { soldAt: "Date", menuItem: "Item", quantity: "Qty", lineTotal: "Total" },
    });
    expect(result.sales[0].lines[0].unitPriceMillis).toBe(12_500);
  });

  it("falls back to the menu price when the file carries no price at all", () => {
    const result = plan("Date,Item,Qty\n2025-06-01,Hamburger,1", {
      mapping: { soldAt: "Date", menuItem: "Item", quantity: "Qty" },
    });
    expect(result.sales[0].lines[0].unitPriceMillis).toBe(18_000);
    // Imported, but the substitution is recorded rather than hidden.
    expect(result.rows[0].status).toBe("import");
    expect(result.rows[0].issues.map(issue => issue.code)).toContain("price_defaulted");
  });

  it("rounds a derived price to the minor unit", () => {
    const result = plan("Date,Item,Qty,Total\n2025-06-01,Hamburger,3,10.000", {
      mapping: { soldAt: "Date", menuItem: "Item", quantity: "Qty", lineTotal: "Total" },
    });
    expect(Number.isInteger(result.sales[0].lines[0].unitPriceMillis)).toBe(true);
  });
});

// ---------------------------------------------------------- invalid row data

describe("invalid rows", () => {
  it("skips a row with no date and says why", () => {
    const result = plan("Date,Item,Qty,Price\n,Hamburger,1,18.000");
    expect(result.rows[0].status).toBe("skip");
    expect(result.rows[0].issues[0].code).toBe("missing_date");
  });

  it("skips an unreadable date", () => {
    const result = plan("Date,Item,Qty,Price\nsometime,Hamburger,1,18.000");
    expect(result.rows[0].issues[0].code).toBe("invalid_date");
  });

  it("skips a row with no menu item value", () => {
    const result = plan("Date,Item,Qty,Price\n2025-06-01,,1,18.000");
    expect(result.rows[0].issues.map(issue => issue.code)).toContain("missing_menu_item");
  });

  it("skips a zero quantity", () => {
    const result = plan("Date,Item,Qty,Price\n2025-06-01,Hamburger,0,18.000");
    expect(result.rows[0].status).toBe("skip");
    expect(result.rows[0].issues.map(issue => issue.code)).toContain("invalid_quantity");
  });

  it("skips a negative quantity", () => {
    const result = plan("Date,Item,Qty,Price\n2025-06-01,Hamburger,-3,18.000");
    expect(result.rows[0].issues.map(issue => issue.code)).toContain("invalid_quantity");
  });

  it("imports a fractional quantity", () => {
    const result = plan("Date,Item,Qty,Price\n2025-06-01,Hamburger,2.5,18.000");
    expect(result.rows[0].status).toBe("import");
    expect(result.sales[0].lines[0].quantity).toBe(2.5);
  });

  it("skips a negative price", () => {
    // A refund line is real, but it is not a sale and must not be imported as
    // one — that would understate revenue while inflating covers.
    const result = plan("Date,Item,Qty,Price\n2025-06-01,Hamburger,1,-18.000");
    expect(result.rows[0].status).toBe("skip");
    expect(result.rows[0].issues.map(issue => issue.code)).toContain("invalid_price");
  });

  it("skips an unreadable price rather than guessing", () => {
    const result = plan("Date,Item,Qty,Price\n2025-06-01,Hamburger,1,n/a");
    expect(result.rows[0].issues.map(issue => issue.code)).toContain("invalid_price");
  });

  it("skips a row whose column count does not match the header", () => {
    const result = plan("Date,Item,Qty,Price\n2025-06-01,Hamburger");
    expect(result.rows[0].status).toBe("skip");
    expect(result.rows[0].issues.map(issue => issue.code)).toContain("ragged_row");
  });

  it("keeps the good rows when only some are bad", () => {
    const result = plan(
      "Date,Item,Qty,Price\n2025-06-01,Hamburger,2,18.000\nbad,Hamburger,1,18.000\n2025-06-02,Frites,1,6.500",
    );
    expect(result.stats.importedRows).toBe(2);
    expect(result.stats.skippedRows).toBe(1);
  });

  it("reports the spreadsheet line number for each problem", () => {
    const result = plan("Date,Item,Qty,Price\n2025-06-01,Hamburger,2,18.000\nbad,Hamburger,1,18.000");
    expect(result.rows.find(row => row.status === "skip")?.line).toBe(3);
  });
});

// -------------------------------------------------------- unknown menu items

describe("unknown menu items", () => {
  const CSV = "Date,Item,Qty,Price\n2025-06-01,Pizza Margherita,1,22.000\n2025-06-02,Pizza Margherita,2,22.000";

  it("never invents a menu item", () => {
    // Requirement 6, the important half: no silent creation.
    const result = plan(CSV);
    expect(result.sales).toHaveLength(0);
    expect(result.stats.importedRows).toBe(0);
  });

  it("skips the row and names the reason", () => {
    const result = plan(CSV);
    expect(result.rows[0].status).toBe("skip");
    expect(result.rows[0].issues[0].code).toBe("unknown_menu_item");
  });

  it("collects each unknown name once, with its rows", () => {
    const result = plan(CSV);
    expect(result.unknownMenuItems).toHaveLength(1);
    expect(result.unknownMenuItems[0]).toMatchObject({ value: "Pizza Margherita", rowCount: 2 });
    expect(result.unknownMenuItems[0].lines).toEqual([2, 3]);
  });

  it("imports the rows once the user maps the name to a real item", () => {
    const result = plan(CSV, { aliases: { "Pizza Margherita": "menu-burger" } });
    expect(result.stats.importedRows).toBe(2);
    expect(result.sales[0].lines[0].menuItemId).toBe("menu-burger");
    expect(result.unknownMenuItems).toHaveLength(0);
  });

  it("keeps the file's price when a name is mapped, not the target item's price", () => {
    const result = plan(CSV, { aliases: { "Pizza Margherita": "menu-burger" } });
    expect(result.sales[0].lines[0].unitPriceMillis).toBe(22_000);
  });

  it("ignores an alias pointing at an item outside the catalog", () => {
    // The catalog is the caller's own organization, so this is also the guard
    // against an alias smuggling in another tenant's menu item id.
    const result = plan(CSV, { aliases: { "Pizza Margherita": "menu-from-another-org" } });
    expect(result.stats.importedRows).toBe(0);
    expect(result.rows[0].issues[0].code).toBe("unknown_menu_item");
  });
});

// ------------------------------------------------------------------ locations

describe("locations", () => {
  const CSV = "Date,Item,Qty,Price,Site\n2025-06-01,Hamburger,1,18.000,Annex\n2025-06-02,Frites,1,6.500,Main";
  const WITH_SITE: ColumnMapping = { ...MAPPING, location: "Site" };

  it("routes each row to the location it names", () => {
    const result = plan(CSV, { mapping: WITH_SITE });
    const byLocation = result.sales.map(sale => sale.locationId);
    expect(byLocation).toContain("loc-annex");
    expect(byLocation).toContain("loc-main");
  });

  it("matches location names case-insensitively", () => {
    const result = plan("Date,Item,Qty,Price,Site\n2025-06-01,Hamburger,1,18.000,ANNEX", { mapping: WITH_SITE });
    expect(result.sales[0].locationId).toBe("loc-annex");
  });

  it("skips a row naming a location that is not in this workspace", () => {
    // Requirement 14 at the row level: an unrecognised site is never coerced
    // into the default, because that would move another branch's revenue.
    const result = plan("Date,Item,Qty,Price,Site\n2025-06-01,Hamburger,1,18.000,Airport", { mapping: WITH_SITE });
    expect(result.rows[0].status).toBe("skip");
    expect(result.rows[0].issues[0].code).toBe("unknown_location");
    expect(result.unknownLocations[0]).toMatchObject({ value: "Airport", rowCount: 1 });
  });

  it("falls back to the chosen location when the cell is empty", () => {
    const result = plan("Date,Item,Qty,Price,Site\n2025-06-01,Hamburger,1,18.000,", { mapping: WITH_SITE });
    expect(result.sales[0].locationId).toBe("loc-main");
  });

  it("respects a restricted location list", () => {
    // What a site-bound member sees: the annex is not theirs to import into.
    const result = plan(CSV, { mapping: WITH_SITE, locations: [{ id: "loc-main", name: "Main" }] });
    expect(result.rows[0].issues[0].code).toBe("unknown_location");
    expect(result.stats.importedRows).toBe(1);
  });
});

// ------------------------------------------------------------------- tickets

describe("grouping into tickets", () => {
  it("joins lines sharing a reference into one sale", () => {
    const result = plan(
      "Date,Item,Qty,Price,Ticket\n2025-06-01 12:00,Hamburger,2,18.000,T-1\n2025-06-01 12:00,Frites,2,6.500,T-1",
      { mapping: { ...MAPPING, reference: "Ticket" } },
    );
    expect(result.sales).toHaveLength(1);
    expect(result.sales[0].lines).toHaveLength(2);
    expect(result.stats.importedRows).toBe(2);
    expect(result.stats.saleCount).toBe(1);
  });

  it("keeps different references apart", () => {
    const result = plan(
      "Date,Item,Qty,Price,Ticket\n2025-06-01,Hamburger,1,18.000,T-1\n2025-06-01,Frites,1,6.500,T-2",
      { mapping: { ...MAPPING, reference: "Ticket" } },
    );
    expect(result.sales).toHaveLength(2);
  });

  it("does not merge the same reference across locations", () => {
    const result = plan(
      "Date,Item,Qty,Price,Ticket,Site\n2025-06-01,Hamburger,1,18.000,1,Main\n2025-06-01,Frites,1,6.500,1,Annex",
      { mapping: { ...MAPPING, reference: "Ticket", location: "Site" } },
    );
    // Till numbering restarts per site; merging would attribute revenue to one.
    expect(result.sales).toHaveLength(2);
  });

  it("does not merge the same reference across days", () => {
    const result = plan(
      "Date,Item,Qty,Price,Ticket\n2025-06-01,Hamburger,1,18.000,1\n2025-06-02,Frites,1,6.500,1",
      { mapping: { ...MAPPING, reference: "Ticket" } },
    );
    expect(result.sales).toHaveLength(2);
  });

  it("keeps rows separate when there is no reference column", () => {
    const result = plan("Date,Item,Qty,Price\n2025-06-01 12:00,Hamburger,1,18.000\n2025-06-01 12:00,Frites,1,6.500");
    expect(result.sales).toHaveLength(2);
  });

  it("totals a multi-line ticket from its own lines", () => {
    const result = plan(
      "Date,Item,Qty,Price,Ticket\n2025-06-01,Hamburger,2,18.000,T-1\n2025-06-01,Frites,1,6.500,T-1",
      { mapping: { ...MAPPING, reference: "Ticket" } },
    );
    expect(result.sales[0].totalMillis).toBe(42_500);
  });
});

// ---------------------------------------------------------------- idempotency

describe("duplicate protection", () => {
  const CSV = "Date,Item,Qty,Price,Ticket\n2025-06-01 12:00,Hamburger,2,18.000,T-1";

  it("gives each sale a stable fingerprint", () => {
    // Requirement 7. The same file planned twice must produce the same key, or
    // the database has nothing to recognise on the second upload.
    const first = plan(CSV, { mapping: { ...MAPPING, reference: "Ticket" } });
    const second = plan(CSV, { mapping: { ...MAPPING, reference: "Ticket" } });
    expect(first.sales[0].idempotencyKey).toBe(second.sales[0].idempotencyKey);
  });

  it("prefers the till's own id when the file provides one", () => {
    const result = plan("Date,Item,Qty,Price,SaleId\n2025-06-01,Hamburger,1,18.000,POS-9", {
      mapping: { ...MAPPING, externalId: "SaleId" },
    });
    expect(result.sales[0].externalId).toBe("POS-9");
    expect(result.sales[0].idempotencyKey).toContain("POS-9");
  });

  it("changes the fingerprint when the contents change", () => {
    const original = plan(CSV, { mapping: { ...MAPPING, reference: "Ticket" } });
    const edited = plan("Date,Item,Qty,Price,Ticket\n2025-06-01 12:00,Hamburger,3,18.000,T-1", {
      mapping: { ...MAPPING, reference: "Ticket" },
    });
    expect(edited.sales[0].idempotencyKey).not.toBe(original.sales[0].idempotencyKey);
  });

  it("separates the same ticket at different locations", () => {
    const main = plan(CSV, { mapping: { ...MAPPING, reference: "Ticket" }, defaultLocationId: "loc-main" });
    const annex = plan(CSV, { mapping: { ...MAPPING, reference: "Ticket" }, defaultLocationId: "loc-annex" });
    expect(main.sales[0].idempotencyKey).not.toBe(annex.sales[0].idempotencyKey);
  });

  it("marks rows the database has already seen as duplicates, not errors", () => {
    const first = plan(CSV, { mapping: { ...MAPPING, reference: "Ticket" } });
    const again = plan(CSV, {
      mapping: { ...MAPPING, reference: "Ticket" },
      existingKeys: new Set([first.sales[0].idempotencyKey]),
    });
    expect(again.stats.importedRows).toBe(0);
    expect(again.stats.duplicateRows).toBe(1);
    expect(again.rows[0].issues[0].code).toBe("duplicate");
    expect(again.sales).toHaveLength(0);
  });

  it("deduplicates a file that repeats a ticket within itself", () => {
    const doubled = `${CSV}\n2025-06-01 12:00,Hamburger,2,18.000,T-1`;
    const result = plan(doubled, { mapping: { ...MAPPING, reference: "Ticket" } });
    // Both rows belong to one ticket, so this is grouping rather than a
    // duplicate — one sale, two lines, counted once.
    expect(result.sales).toHaveLength(1);
    expect(result.stats.saleCount).toBe(1);
  });

  it("imports the new rows when a file is re-uploaded with extra days", () => {
    const first = plan(CSV, { mapping: { ...MAPPING, reference: "Ticket" } });
    const extended = plan(`${CSV}\n2025-06-02 12:00,Frites,1,6.500,T-2`, {
      mapping: { ...MAPPING, reference: "Ticket" },
      existingKeys: new Set([first.sales[0].idempotencyKey]),
    });
    expect(extended.stats.duplicateRows).toBe(1);
    expect(extended.stats.importedRows).toBe(1);
  });
});

// ------------------------------------------------------------- error reports

describe("the downloadable error report", () => {
  it("includes only the skipped rows, with their original cells", () => {
    const table = parseCsv("Date,Item,Qty,Price\n2025-06-01,Hamburger,2,18.000\nbad,Hamburger,1,18.000");
    const result = buildImportPlan(rowsFromTable(table), {
      mapping: MAPPING,
      catalog: CATALOG,
      locations: LOCATIONS,
      defaultLocationId: "loc-main",
      currency: "TND",
      dateFormat: "auto",
    });
    const report = buildErrorReport(result, table.headers);
    expect(report[0]).toEqual(["Line", "Problem", "Date", "Item", "Qty", "Price"]);
    expect(report).toHaveLength(2);
    expect(report[1][0]).toBe(3);
    expect(String(report[1][1])).toMatch(/date/i);
    expect(report[1].slice(2)).toEqual(["bad", "Hamburger", "1", "18.000"]);
  });

  it("is just a header when nothing was skipped", () => {
    const table = parseCsv("Date,Item,Qty,Price\n2025-06-01,Hamburger,2,18.000");
    const result = buildImportPlan(rowsFromTable(table), {
      mapping: MAPPING,
      catalog: CATALOG,
      locations: LOCATIONS,
      defaultLocationId: "loc-main",
      currency: "TND",
      dateFormat: "auto",
    });
    expect(buildErrorReport(result, table.headers)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ integrity

describe("plan integrity", () => {
  it("counts every row exactly once", () => {
    const result = plan(
      "Date,Item,Qty,Price\n2025-06-01,Hamburger,2,18.000\nbad,Hamburger,1,18.000\n2025-06-02,Unknown Dish,1,5.000",
    );
    expect(result.stats.importedRows + result.stats.skippedRows).toBe(result.stats.totalRows);
  });

  it("agrees with its own line count", () => {
    const result = plan("Date,Item,Qty,Price\n2025-06-01,Hamburger,2,18.000\n2025-06-02,Frites,1,6.500");
    const lines = result.sales.reduce((sum, sale) => sum + sale.lines.length, 0);
    expect(lines).toBe(result.stats.importedRows);
  });

  it("totals the same as the sum of its sales", () => {
    const result = plan("Date,Item,Qty,Price\n2025-06-01,Hamburger,2,18.000\n2025-06-02,Frites,3,6.500");
    const summed = result.sales.reduce((total, sale) => total + sale.totalMillis, 0);
    expect(summed).toBe(result.stats.totalMillis);
  });

  it("plans nothing from an empty file", () => {
    const result = plan("Date,Item,Qty,Price\n");
    expect(result.sales).toHaveLength(0);
    expect(result.stats.totalRows).toBe(0);
    expect(result.period).toBeNull();
  });

  it("handles a file where every row is unusable", () => {
    const result = plan("Date,Item,Qty,Price\nbad,,,\nworse,,,");
    expect(result.stats.importedRows).toBe(0);
    expect(result.stats.skippedRows).toBe(2);
    expect(result.sales).toHaveLength(0);
  });
});

// -------------------------------------------------------------- sample file

describe("the downloadable example", () => {
  const MENU = [
    { name: "Hamburger", sellingPriceMillis: 18_000 },
    { name: "Frites", sellingPriceMillis: 6_500 },
  ];
  const TODAY = new Date(2026, 7, 10, 12, 0, 0);

  it("uses the documented header", () => {
    const rows = buildSampleCsvRows(MENU, "Main", "TND", TODAY);
    expect(rows[0]).toEqual(["sale_id", "sold_at", "location", "menu_item", "quantity", "unit_price"]);
  });

  it("includes several example rows", () => {
    expect(buildSampleCsvRows(MENU, "Main", "TND", TODAY).length).toBeGreaterThan(3);
  });

  it("draws dish names from the workspace's own menu", () => {
    // A fixed sample naming dishes the restaurant does not sell would fail to
    // import on the very file we handed them.
    const rows = buildSampleCsvRows(MENU, "Main", "TND", TODAY).slice(1);
    const names = new Set(MENU.map(item => item.name));
    expect(rows.every(row => names.has(row[3]))).toBe(true);
  });

  it("uses the workspace's own location", () => {
    const rows = buildSampleCsvRows(MENU, "Annex", "TND", TODAY).slice(1);
    expect(rows.every(row => row[2] === "Annex")).toBe(true);
  });

  it("formats prices in the currency's major units", () => {
    const rows = buildSampleCsvRows(MENU, "Main", "TND", TODAY).slice(1);
    // TND has three decimal places: 18000 millimes prints as 18.000.
    expect(rows.some(row => row[5] === "18.000")).toBe(true);
  });

  it("formats prices for a two-decimal currency too", () => {
    const rows = buildSampleCsvRows([{ name: "Burger", sellingPriceMillis: 1_850 }], "Main", "USD", TODAY).slice(1);
    expect(rows[0][5]).toBe("18.50");
  });

  it("demonstrates a multi-line ticket", () => {
    // Two rows sharing a sale_id is how an order of several dishes is written.
    const rows = buildSampleCsvRows(MENU, "Main", "TND", TODAY).slice(1);
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row[0], (counts.get(row[0]) ?? 0) + 1);
    expect([...counts.values()].some(count => count > 1)).toBe(true);
  });

  it("copes with a single-dish menu", () => {
    const rows = buildSampleCsvRows([{ name: "Only Dish", sellingPriceMillis: 5_000 }], "Main", "TND", TODAY);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.slice(1).every(row => row[3] === "Only Dish")).toBe(true);
  });

  it("maps itself when uploaded, with nothing left to choose", () => {
    // The point of the sample: it walks through the wizard without the owner
    // having to understand the mapping screen first.
    const csv = toCsv(buildSampleCsvRows(MENU, "Main", "TND", TODAY));
    const table = parseCsv(csv);
    const mapping = suggestMapping(table.headers);
    expect(missingRequiredFields(mapping)).toEqual([]);
    expect(mapping.soldAt).toBe("sold_at");
    expect(mapping.menuItem).toBe("menu_item");
    expect(mapping.quantity).toBe("quantity");
    expect(mapping.unitPrice).toBe("unit_price");
    expect(mapping.location).toBe("location");
    expect(mapping.externalId).toBe("sale_id");
  });

  it("imports cleanly through the real pipeline", () => {
    // End to end against the actual planner: every row lands, nothing is
    // skipped, and the prices survive as written.
    const csv = toCsv(buildSampleCsvRows(MENU, "Main", "TND", TODAY));
    const table = parseCsv(csv);
    const result = buildImportPlan(rowsFromTable(table), {
      mapping: suggestMapping(table.headers),
      catalog: [
        { id: "menu-burger", name: "Hamburger", sellingPriceMillis: 18_000 },
        { id: "menu-fries", name: "Frites", sellingPriceMillis: 6_500 },
      ],
      locations: [{ id: "loc-main", name: "Main" }],
      defaultLocationId: "loc-main",
      currency: "TND",
      dateFormat: "auto",
    });

    expect(result.stats.skippedRows).toBe(0);
    expect(result.stats.importedRows).toBe(result.stats.totalRows);
    expect(result.unknownMenuItems).toEqual([]);
    expect(result.stats.totalMillis).toBeGreaterThan(0);
  });

  it("groups its shared ticket into one sale", () => {
    const csv = toCsv(buildSampleCsvRows(MENU, "Main", "TND", TODAY));
    const table = parseCsv(csv);
    const result = buildImportPlan(rowsFromTable(table), {
      mapping: suggestMapping(table.headers),
      catalog: [
        { id: "menu-burger", name: "Hamburger", sellingPriceMillis: 18_000 },
        { id: "menu-fries", name: "Frites", sellingPriceMillis: 6_500 },
      ],
      locations: [{ id: "loc-main", name: "Main" }],
      defaultLocationId: "loc-main",
      currency: "TND",
      dateFormat: "auto",
    });
    // Five rows, four distinct tickets.
    expect(result.stats.saleCount).toBeLessThan(result.stats.importedRows);
  });

  it("is stable, so downloading twice gives the same file", () => {
    const first = buildSampleCsvRows(MENU, "Main", "TND", TODAY);
    const second = buildSampleCsvRows(MENU, "Main", "TND", TODAY);
    expect(first).toEqual(second);
  });
});
