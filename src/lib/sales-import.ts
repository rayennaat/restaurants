/**
 * The sales import pipeline.
 *
 * One vendor-neutral path from tabular rows to sales:
 *
 *   rows + mapping → normalize → validate → group into tickets → plan → commit
 *
 * Everything here is pure. The server calls it to build the authoritative plan
 * it will write, and the same functions could run in a browser preview without
 * change. Purity is also what makes the awkward parts testable: date
 * interpretation, decimal commas, ticket grouping and idempotency keys are all
 * asserted directly rather than through a database.
 *
 * **Why there is no POS-specific code in here.** Different tills export
 * different shapes, so the format is described by data — a {@link ColumnMapping}
 * naming which source column feeds which field — rather than by a per-vendor
 * branch. A CSV upload produces that mapping from the user's choices; a future
 * direct POS adapter produces it (or the normalized rows directly) from an API
 * response. Both then join {@link buildImportPlan}, so validation, menu-item
 * resolution, idempotency and the transactional write are written once. See
 * {@link SalesImportAdapter}.
 *
 * **Nothing here writes.** The plan is a description of intended rows; the
 * caller commits it in a single transaction. That split is what lets the preview
 * screen show exactly what the import will do, computed by the same code that
 * will do it, with no second implementation to drift.
 */

import { minorUnitExponent, toMinorUnits } from "@/lib/money";

// ---------------------------------------------------------------- the fields

/**
 * The fields an import can populate. This is the vocabulary a mapping speaks,
 * and the contract a future POS adapter targets.
 */
export const IMPORT_FIELDS = [
  "soldAt",
  "menuItem",
  "quantity",
  "unitPrice",
  "lineTotal",
  "location",
  "reference",
  "externalId",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const REQUIRED_FIELDS = ["soldAt", "menuItem", "quantity"] as const satisfies readonly ImportField[];

export const FIELD_LABELS: Record<ImportField, string> = {
  soldAt: "Date / time",
  menuItem: "Menu item",
  quantity: "Quantity",
  unitPrice: "Unit price",
  lineTotal: "Line total",
  location: "Location",
  reference: "Ticket reference",
  externalId: "External sale ID",
};

export const FIELD_HINTS: Record<ImportField, string> = {
  soldAt: "When the sale happened.",
  menuItem: "The dish name as your till writes it.",
  quantity: "How many were sold on this line.",
  unitPrice: "Price for one unit, as it was sold. Kept exactly as imported.",
  lineTotal: "Total for the line. Used to derive the unit price when that column is absent.",
  location: "Which restaurant. Falls back to the location you choose below.",
  reference: "Ticket or receipt number. Lines sharing one become a single sale.",
  externalId: "The till's own ID for the sale. Used to prevent double-importing.",
};

/**
 * Which source column feeds each field. A value of `null` means "not provided",
 * which is legal for everything outside {@link REQUIRED_FIELDS}.
 */
export type ColumnMapping = Partial<Record<ImportField, string | null>>;

// ------------------------------------------------------ mapping suggestions

/**
 * Header aliases, lowercased and stripped of punctuation before matching.
 *
 * This list is a convenience, never a requirement: it only pre-selects the
 * dropdowns on the mapping screen, and the user can override every one. That
 * distinction is what keeps the product POS-neutral — a till we have never seen
 * still imports, it just starts with more dropdowns unset.
 */
const HEADER_ALIASES: Record<ImportField, string[]> = {
  soldAt: ["date", "datetime", "date time", "timestamp", "sold at", "time", "order date", "business date", "closed at", "day", "date heure", "horodatage"],
  menuItem: ["item", "menu item", "product", "product name", "item name", "description", "article", "dish", "plu name", "produit", "libelle"],
  quantity: ["qty", "quantity", "count", "units", "sold", "quantite", "qte", "nb"],
  unitPrice: ["price", "unit price", "unit_price", "item price", "price each", "amount each", "prix", "prix unitaire", "pu"],
  lineTotal: ["total", "line total", "amount", "net sales", "gross sales", "revenue", "net amount", "montant", "total ligne"],
  location: ["location", "site", "store", "restaurant", "branch", "outlet", "venue", "etablissement"],
  reference: ["ticket", "receipt", "check", "order", "order id", "order number", "ticket number", "receipt number", "check number", "bill", "table"],
  externalId: ["external id", "sale id", "transaction id", "transaction", "id", "uuid", "guid", "pos id", "reference id"],
};

/** Lowercase, drop punctuation, collapse whitespace — so "Order_Date" ≍ "order date". */
function normalizeHeader(header: string) {
  return header
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pre-selects a mapping from the file's own headers.
 *
 * Exact alias matches win over partial ones, and each source column is claimed
 * at most once — otherwise a file with both "Price" and "Total Price" could map
 * the same column to two different fields and double-count the money.
 */
export function suggestMapping(headers: string[]): ColumnMapping {
  const normalized = headers.map(header => ({ header, key: normalizeHeader(header) }));
  const claimed = new Set<string>();
  const mapping: ColumnMapping = {};

  const claim = (field: ImportField, header: string) => {
    mapping[field] = header;
    claimed.add(header);
  };

  // Exact matches first, across all fields, so a precise header is never stolen
  // by another field's loose prefix match.
  for (const field of IMPORT_FIELDS) {
    const aliases = HEADER_ALIASES[field];
    const exact = normalized.find(entry => !claimed.has(entry.header) && aliases.includes(entry.key));
    if (exact) claim(field, exact.header);
  }

  for (const field of IMPORT_FIELDS) {
    if (mapping[field]) continue;
    const aliases = HEADER_ALIASES[field];
    const partial = normalized.find(
      entry => !claimed.has(entry.header) && aliases.some(alias => entry.key.includes(alias) || alias.includes(entry.key)),
    );
    if (partial) claim(field, partial.header);
  }

  return mapping;
}

// ------------------------------------------------------------- value parsing

export const DATE_FORMATS = ["auto", "dmy", "mdy", "ymd"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const DATE_FORMAT_LABELS: Record<DateFormat, string> = {
  auto: "Detect automatically",
  dmy: "Day first (31/12/2025)",
  mdy: "Month first (12/31/2025)",
  ymd: "Year first (2025-12-31)",
};

/**
 * Reads a date from a cell.
 *
 * `03/04/2025` is genuinely ambiguous — 3 April in most of the world, 4 March in
 * the United States — and guessing wrong moves a day's revenue to the wrong
 * month. So the caller states the convention, and `auto` only resolves the
 * ambiguity when one reading is impossible (a component above 12 must be the
 * day). When neither component settles it, `auto` uses day-first, matching the
 * product's locale, and the UI tells the user which reading was applied.
 *
 * The returned Date is built from local components rather than parsed as UTC:
 * a till exporting `2025-12-31 23:30` means half past eleven in the restaurant.
 */
export function parseImportDate(raw: string, format: DateFormat = "auto"): Date | null {
  const value = raw.trim();
  if (!value) return null;

  // ISO-ish: 2025-12-31, 2025-12-31 23:30, 2025-12-31T23:30:00(Z|±hh:mm)
  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/);
  if (iso) {
    const [, year, month, day, hour, minute, second, zone] = iso;
    // An explicit zone is authoritative; without one the timestamp is local.
    if (zone) {
      const parsed = new Date(value.replace(" ", "T"));
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return makeDate(Number(year), Number(month), Number(day), Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0));
  }

  // Slash/dot/dash separated, with an optional time and am/pm suffix.
  const parts = value.match(
    /^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})(?:[T ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([AaPp][Mm])?$/,
  );
  if (parts) {
    const [, first, second, third, hourRaw, minute, secondsRaw, meridiem] = parts;
    let hour = Number(hourRaw ?? 0);
    if (meridiem) {
      const pm = /^[Pp]/.test(meridiem);
      if (hour === 12) hour = pm ? 12 : 0;
      else if (pm) hour += 12;
    }

    let day: number;
    let month: number;
    let year: number;

    if (first.length === 4 || format === "ymd") {
      year = Number(first);
      month = Number(second);
      day = Number(third);
    } else {
      year = Number(third);
      const a = Number(first);
      const b = Number(second);

      if (format === "mdy") {
        month = a;
        day = b;
      } else if (format === "dmy") {
        day = a;
        month = b;
      } else {
        // auto: let an impossible month decide, else day-first.
        if (a > 12 && b <= 12) {
          day = a;
          month = b;
        } else if (b > 12 && a <= 12) {
          month = a;
          day = b;
        } else {
          day = a;
          month = b;
        }
      }
    }

    if (year < 100) year += year < 70 ? 2000 : 1900;
    return makeDate(year, month, day, hour, Number(minute ?? 0), Number(secondsRaw ?? 0));
  }

  return null;
}

/**
 * Builds a Date and rejects overflow.
 *
 * `new Date(2025, 1, 30)` silently becomes 2 March. Reading the components back
 * catches that, so an invalid date is reported to the user rather than importing
 * revenue onto a day that was never in the file.
 */
function makeDate(year: number, month: number, day: number, hour: number, minute: number, second: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

/**
 * Reads a number from a cell written in any of the conventions a till might use.
 *
 * `1,234.56` (thousands comma), `1.234,56` (European), `18,500` (decimal comma),
 * `1 234,56` (space grouping), `(4.00)` (accounting negative) and currency
 * symbols all appear in real exports.
 *
 * Two separators is unambiguous: the rightmost one is the decimal point, which
 * distinguishes `1.234,56` from `1,234.56` without knowing the locale.
 *
 * **One comma before exactly three digits is genuinely ambiguous** — `18,500` is
 * 18.5 dinars on a Tunisian till and one thousand five hundred on an American
 * one, and no amount of cleverness settles it from the string alone. So the
 * currency decides: `minorDigits` is how many decimal places the currency
 * actually has (3 for TND, 2 for USD and EUR), and a separator followed by
 * exactly that many digits is read as a decimal point. For TND `18,500` is 18.5;
 * for USD `1,500` is 1500, because dollars have no third decimal place for those
 * digits to occupy. This is the one place the product's currency changes how a
 * file is read, and it is why the import screen states the currency explicitly.
 */
export function parseDecimal(raw: string, minorDigits = 3): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Accounting parentheses mean negative. Preserved rather than dropped, so the
  // validator can reject a refund line with a clear message instead of silently
  // importing it as revenue.
  const negative = /^\(.*\)$/.test(trimmed);
  let value = trimmed.replace(/^\((.*)\)$/, "$1");

  // Strip currency symbols, letters (TND, DT, USD) and every kind of space —
  // including the non-breaking and narrow no-break spaces Excel writes as
  // thousands separators.
  value = value.replace(/[^\d,.\-+]/g, "");
  if (!value || !/\d/.test(value)) return null;

  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");

  if (lastComma !== -1 && lastDot !== -1) {
    // Both present: the rightmost is the decimal separator, the other grouping.
    if (lastComma > lastDot) value = value.replace(/\./g, "").replace(",", ".");
    else value = value.replace(/,/g, "");
  } else if (lastComma !== -1) {
    const commas = value.split(",").length - 1;
    const after = value.length - lastComma - 1;
    // Several commas can only be grouping. A single one is decided by the
    // currency, as explained above; anything longer than the currency's decimal
    // places cannot be a fraction of it.
    if (commas > 1 || after > Math.max(minorDigits, 2)) value = value.replace(/,/g, "");
    else if (after === 3 && minorDigits < 3) value = value.replace(",", "");
    else value = value.replace(",", ".");
  } else if (lastDot !== -1) {
    const dots = value.split(".").length - 1;
    if (dots > 1) value = value.replace(/\./g, "");
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

/**
 * Reads a sold quantity.
 *
 * Fractional quantities are accepted deliberately, matching manual entry: a half
 * portion is real, and a till selling by weight exports `0.35`. What is rejected
 * is a quantity that cannot describe a sale at all — zero, negative, unreadable,
 * or large enough that it is far more likely a misread column than a real order.
 */
export function parseQuantity(raw: string, minorDigits = 3): number | null {
  const value = parseDecimal(raw, minorDigits);
  if (value === null || !Number.isFinite(value)) return null;
  if (value <= 0 || value > 1_000_000) return null;
  return value;
}

/** Money from a cell, in the integer minor units the database stores. */
export function parseImportMoney(raw: string, currency: string): number | null {
  const value = parseDecimal(raw, minorUnitExponent(currency));
  if (value === null) return null;
  return toMinorUnits(value, currency);
}

// ------------------------------------------------------------------- issues

/**
 * Everything that can be wrong with a row.
 *
 * A closed set rather than free text, so the preview can group ("42 rows: menu
 * item not found"), the downloadable report can be filtered, and a message can
 * be reworded without breaking anything that counts occurrences.
 */
export const IMPORT_ISSUE_CODES = [
  "missing_date",
  "invalid_date",
  "missing_menu_item",
  "unknown_menu_item",
  "missing_quantity",
  "invalid_quantity",
  "invalid_price",
  "unknown_location",
  "ragged_row",
  "duplicate",
  "price_defaulted",
] as const;
export type ImportIssueCode = (typeof IMPORT_ISSUE_CODES)[number];

/**
 * `error` skips the row; `warning` imports it with a note.
 *
 * Only two levels, because the user's decision is binary: a row either lands or
 * it does not, and anything softer would leave them guessing which.
 */
export type IssueSeverity = "error" | "warning";

export const ISSUE_SEVERITY: Record<ImportIssueCode, IssueSeverity> = {
  missing_date: "error",
  invalid_date: "error",
  missing_menu_item: "error",
  unknown_menu_item: "error",
  missing_quantity: "error",
  invalid_quantity: "error",
  invalid_price: "error",
  unknown_location: "error",
  ragged_row: "warning",
  duplicate: "warning",
  price_defaulted: "warning",
};

export const ISSUE_LABELS: Record<ImportIssueCode, string> = {
  missing_date: "Date is empty",
  invalid_date: "Date could not be read",
  missing_menu_item: "Menu item is empty",
  unknown_menu_item: "Menu item not found",
  missing_quantity: "Quantity is empty",
  invalid_quantity: "Quantity is not a positive number",
  invalid_price: "Price is not a valid amount",
  unknown_location: "Location not found",
  ragged_row: "Row has a different number of columns than the header",
  duplicate: "Already imported previously",
  price_defaulted: "No price in the file — the current menu price was used",
};

export type ImportIssue = {
  code: ImportIssueCode;
  severity: IssueSeverity;
  /** Human message, naming the offending value where that helps. */
  message: string;
  /** The cell that caused it, when one did. */
  value?: string;
};

function issue(code: ImportIssueCode, message?: string, value?: string): ImportIssue {
  return { code, severity: ISSUE_SEVERITY[code], message: message ?? ISSUE_LABELS[code], value };
}

// --------------------------------------------------------------- the pipeline

/** A row as the pipeline sees it: source line number plus mapped raw cells. */
export type SourceRow = {
  /** 1-based line in the original file, header included, for error messages. */
  line: number;
  cells: Record<string, string>;
  /** True when the parser found this row's width disagreed with the header. */
  ragged?: boolean;
};

/** A menu item from the caller's own organization. Names are matched against this. */
export type ImportCatalogItem = {
  id: string;
  name: string;
  sellingPriceMillis: number;
};

/** A location from the caller's own organization, for resolving a location column. */
export type ImportLocationOption = { id: string; name: string };

export type ImportPlanContext = {
  mapping: ColumnMapping;
  /** Menu items the caller's organization owns — the tenant boundary of the import. */
  catalog: ImportCatalogItem[];
  /** Location used when a row names none, or when no location column is mapped. */
  defaultLocationId: string;
  /** Locations the caller may import into. A row naming anything else is an error. */
  locations: ImportLocationOption[];
  currency: string;
  dateFormat?: DateFormat;
  /**
   * Manual resolutions for names the catalog does not contain: the CSV's own text
   * mapped to a menu item id the user picked. This is what makes "Menu item not
   * found" fixable without inventing a dish — nothing here ever creates one.
   */
  aliases?: Record<string, string>;
  /**
   * Idempotency keys already stored for this organization and source. Rows
   * matching one are reported as already imported and skipped, which is what
   * makes re-running the same file a no-op rather than doubling revenue.
   */
  existingKeys?: Iterable<string>;
};

export type PlannedLine = {
  menuItemId: string;
  menuItemName: string;
  quantity: number;
  unitPriceMillis: number;
  lineTotalMillis: number;
  sortOrder: number;
  /** Where the price came from. `menu` means the file carried none. */
  pricedFrom: "file" | "menu";
  /** Source line, kept so the audit trail and the report can point back. */
  line: number;
};

export type PlannedSale = {
  /**
   * What gets stored in `sales.external_id` — the value the unique index dedupes
   * on. Either the till's own id, or a hash of the sale's contents when the file
   * has none. Always set, so every imported sale is protected against a re-run.
   */
  idempotencyKey: string;
  /** The till's own id, when the file provided one. Null otherwise. */
  externalId: string | null;
  locationId: string;
  reference: string | null;
  soldAt: Date;
  totalMillis: number;
  lines: PlannedLine[];
};

export type RowOutcome = {
  line: number;
  /** Cells as read, for the error report. */
  cells: Record<string, string>;
  status: "import" | "skip";
  issues: ImportIssue[];
  /** Set when the row resolved to a dish, so the preview can show what it matched. */
  resolvedMenuItemName?: string;
};

export type UnresolvedValue = { value: string; rowCount: number; lines: number[] };

export type ImportPlan = {
  sales: PlannedSale[];
  rows: RowOutcome[];
  /** Distinct menu item names the catalog could not account for, most frequent first. */
  unknownMenuItems: UnresolvedValue[];
  unknownLocations: UnresolvedValue[];
  stats: {
    totalRows: number;
    importedRows: number;
    skippedRows: number;
    /** Rows skipped because they were imported before. Counted separately from failures. */
    duplicateRows: number;
    saleCount: number;
    totalMillis: number;
    unitsSold: number;
    warningRows: number;
  };
  /** Earliest and latest sale in the plan, for the preview's summary line. */
  period: { from: Date; to: Date } | null;
};

/** Case- and accent-insensitive key, so "CAFÉ crème " matches "Café Crème". */
export function matchKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A short, stable hash of a string.
 *
 * Two 32-bit FNV-1a accumulators run with different offsets and combined, giving
 * 64 bits in 16 hex characters. Not cryptographic and not meant to be: its only
 * job is to make a deterministic idempotency key that fits in a text column and
 * is stable across processes — which `Math.random`, object iteration order or a
 * timestamp would not be. Collisions are scoped to one organization and one
 * source, where the volume is thousands of rows against 2^64 buckets.
 */
export function stableHash(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charCodeAt(i);
    a ^= char;
    a = Math.imul(a, 0x01000193) >>> 0;
    b ^= char + i;
    b = Math.imul(b, 0x85ebca6b) >>> 0;
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** Reads a mapped cell, or "" when the field is unmapped. */
function cell(row: SourceRow, mapping: ColumnMapping, field: ImportField): string {
  const column = mapping[field];
  if (!column) return "";
  return (row.cells[column] ?? "").trim();
}


/**
 * Validates and normalizes rows into the sales an import would create.
 *
 * The single place the rules live, so the preview and the commit cannot
 * disagree about what will happen:
 *
 * **Menu items are resolved, never created.** A name is matched against the
 * caller's own catalog (case- and accent-insensitively), or against an alias the
 * user chose on the mapping screen. Anything else is an error and the row is
 * skipped. Since the catalog is loaded scoped to one organization, a dish
 * belonging to another tenant simply does not resolve — the tenant boundary and
 * the validation are the same check.
 *
 * **Prices come from the file.** `unitPrice` is used as given; failing that, a
 * `lineTotal` is divided by the quantity. Only when the file carries neither is
 * the current menu price used, and that row is flagged `priced_from_menu` so the
 * user knows some figures are today's prices rather than historical ones.
 *
 * **Lines become tickets.** Rows sharing a reference (or an external id) on the
 * same date at the same location are one sale, which is how a POS export of
 * ticket lines reconstructs the ticket. Rows with no reference each become their
 * own single-line sale rather than being merged, because merging unrelated rows
 * would invent transactions that never happened.
 *
 * **Every sale gets a deterministic external id**, so re-importing the same file
 * collides with the unique index instead of doubling revenue — even when the
 * till provided no id of its own.
 */
export function buildImportPlan(rows: SourceRow[], context: ImportPlanContext): ImportPlan {
  const { mapping, catalog, currency, defaultLocationId } = context;
  const dateFormat = context.dateFormat ?? "auto";

  const byName = new Map(catalog.map(item => [matchKey(item.name), item]));
  const byId = new Map(catalog.map(item => [item.id, item]));
  const locationByName = new Map(context.locations.map(option => [matchKey(option.name), option.id]));
  const locationById = new Set(context.locations.map(option => option.id));
  const aliases = new Map(Object.entries(context.aliases ?? {}).map(([value, id]) => [matchKey(value), id]));
  const alreadyImported = new Set(context.existingKeys ?? []);

  const outcomes: RowOutcome[] = [];
  const unknownItems = new Map<string, UnresolvedValue>();
  const unknownLocations = new Map<string, UnresolvedValue>();

  /** Accumulates rows into tickets while preserving first-seen order. */
  const groups = new Map<
    string,
    { locationId: string; reference: string | null; externalId: string | null; soldAt: Date; lines: PlannedLine[] }
  >();

  const track = (map: Map<string, UnresolvedValue>, value: string, line: number) => {
    const key = matchKey(value);
    const entry = map.get(key);
    if (entry) {
      entry.rowCount += 1;
      if (entry.lines.length < 20) entry.lines.push(line);
    } else {
      map.set(key, { value, rowCount: 1, lines: [line] });
    }
  };

  for (const row of rows) {
    const issues: ImportIssue[] = [];
    if (row.ragged) issues.push(issue("ragged_row"));

    // ------------------------------------------------------------------ date
    const rawDate = cell(row, mapping, "soldAt");
    let soldAt: Date | null = null;
    if (!rawDate) issues.push(issue("missing_date"));
    else {
      soldAt = parseImportDate(rawDate, dateFormat);
      if (!soldAt) issues.push(issue("invalid_date", `Could not read "${rawDate}" as a date.`, rawDate));
    }

    // ------------------------------------------------------------- menu item
    const rawItem = cell(row, mapping, "menuItem");
    let menuItem: ImportCatalogItem | undefined;
    if (!rawItem) {
      issues.push(issue("missing_menu_item"));
    } else {
      const aliasTarget = aliases.get(matchKey(rawItem));
      menuItem = aliasTarget ? byId.get(aliasTarget) : byName.get(matchKey(rawItem));
      if (!menuItem) {
        issues.push(issue("unknown_menu_item", `"${rawItem}" does not match a menu item in this workspace.`, rawItem));
        track(unknownItems, rawItem, row.line);
      }
    }

    // -------------------------------------------------------------- quantity
    const rawQuantity = cell(row, mapping, "quantity");
    let quantity: number | null = null;
    if (!rawQuantity) {
      issues.push(issue("missing_quantity"));
    } else {
      quantity = parseQuantity(rawQuantity, minorUnitExponent(currency));
      if (quantity === null) {
        issues.push(issue("invalid_quantity", `"${rawQuantity}" is not a quantity greater than zero.`, rawQuantity));
      }
    }

    // ----------------------------------------------------------------- price
    const rawUnitPrice = cell(row, mapping, "unitPrice");
    const rawLineTotal = cell(row, mapping, "lineTotal");
    let unitPriceMillis: number | null = null;
    let pricedFrom: "file" | "menu" = "file";

    if (rawUnitPrice) {
      unitPriceMillis = parseImportMoney(rawUnitPrice, currency);
      if (unitPriceMillis === null || unitPriceMillis < 0) {
        issues.push(issue("invalid_price", `"${rawUnitPrice}" is not a valid price.`, rawUnitPrice));
        unitPriceMillis = null;
      }
    } else if (rawLineTotal) {
      const total = parseImportMoney(rawLineTotal, currency);
      if (total === null || total < 0) {
        issues.push(issue("invalid_price", `"${rawLineTotal}" is not a valid amount.`, rawLineTotal));
      } else if (quantity !== null) {
        // Derived, then rounded once — the line total is recomputed from this
        // unit price below, so the two always agree on screen.
        unitPriceMillis = Math.round(total / quantity);
      }
    } else if (menuItem) {
      // Last resort: today's menu price. Flagged, because it is the one case
      // where an imported figure is not historical.
      unitPriceMillis = menuItem.sellingPriceMillis;
      pricedFrom = "menu";
      issues.push(issue("price_defaulted"));
    }

    // -------------------------------------------------------------- location
    const rawLocation = cell(row, mapping, "location");
    let locationId = defaultLocationId;
    if (rawLocation) {
      const matched = locationByName.get(matchKey(rawLocation)) ?? (locationById.has(rawLocation) ? rawLocation : undefined);
      if (matched) {
        locationId = matched;
      } else {
        issues.push(issue("unknown_location", `"${rawLocation}" is not a location in this workspace.`, rawLocation));
        track(unknownLocations, rawLocation, row.line);
      }
    }

    // ------------------------------------------------------------- reference
    const reference = cell(row, mapping, "reference") || null;
    const providedExternalId = cell(row, mapping, "externalId") || null;

    const blocked = issues.some(entry => entry.severity === "error");
    if (blocked || !soldAt || !menuItem || quantity === null || unitPriceMillis === null) {
      // A row can reach here with no error issue only if a price could not be
      // derived — no price column and no menu item to fall back on. That case is
      // already reported as unknown_menu_item, so nothing is dropped silently.
      outcomes.push({ line: row.line, cells: row.cells, status: "skip", issues });
      continue;
    }

    /**
     * The ticket this line belongs to.
     *
     * An explicit external id groups outright. A reference groups within one
     * day and location, so ticket numbers that restart each service do not
     * merge across days. Everything else is its own sale, keyed by line number.
     */
    const day = `${soldAt.getFullYear()}-${soldAt.getMonth() + 1}-${soldAt.getDate()}`;
    const groupKey = providedExternalId
      ? `x:${providedExternalId}`
      : reference
        ? `r:${locationId}:${day}:${matchKey(reference)}`
        : `l:${row.line}`;

    let group = groups.get(groupKey);
    if (!group) {
      group = { locationId, reference, externalId: providedExternalId, soldAt, lines: [] };
      groups.set(groupKey, group);
    }

    group.lines.push({
      menuItemId: menuItem.id,
      menuItemName: menuItem.name,
      quantity,
      unitPriceMillis,
      lineTotalMillis: Math.round(quantity * unitPriceMillis),
      sortOrder: group.lines.length,
      pricedFrom,
      line: row.line,
    });

    outcomes.push({
      line: row.line,
      cells: row.cells,
      status: "import",
      issues,
      resolvedMenuItemName: menuItem.name,
    });
  }

  // -------------------------------------------------------- tickets to sales
  const sales: PlannedSale[] = [];
  const duplicateLines = new Set<number>();
  const seenKeys = new Set<string>();

  for (const group of groups.values()) {
    /**
     * The idempotency key.
     *
     * When the till supplied an id, that is used verbatim — it is the most
     * faithful identity available, and it matches across re-exports even if the
     * file is re-sorted or re-sliced. Otherwise one is derived from the sale's
     * own content: location, timestamp, reference and every line. Re-importing
     * the same file then produces the same key and collides with the unique
     * index, while a genuinely different sale hashes differently.
     *
     * Deliberately *not* derived from the filename or row position: importing
     * the same day's data from a re-exported file must still be recognized as
     * the same sales.
     */
    const idempotencyKey = group.externalId
      ? `pos:${group.externalId}`
      : `csv:${stableHash(
          [
            group.locationId,
            group.soldAt.toISOString(),
            group.reference ?? "",
            ...group.lines.map(line => `${line.menuItemId}|${line.quantity}|${line.unitPriceMillis}`),
          ].join(" "),
        )}`;

    // Already in the database, or already planned earlier in this same file.
    // Two identical tickets in one upload would otherwise violate the unique
    // index mid-transaction and abort the entire import.
    if (alreadyImported.has(idempotencyKey) || seenKeys.has(idempotencyKey)) {
      for (const line of group.lines) duplicateLines.add(line.line);
      continue;
    }
    seenKeys.add(idempotencyKey);

    sales.push({
      idempotencyKey,
      externalId: group.externalId,
      locationId: group.locationId,
      reference: group.reference,
      soldAt: group.soldAt,
      totalMillis: group.lines.reduce((sum, line) => sum + line.lineTotalMillis, 0),
      lines: group.lines,
    });
  }

  // Fold duplicate detection back into the row outcomes, so one list drives the
  // preview table, the counts and the error report.
  for (const outcome of outcomes) {
    if (outcome.status === "import" && duplicateLines.has(outcome.line)) {
      outcome.status = "skip";
      outcome.issues = [...outcome.issues, issue("duplicate")];
    }
  }

  const imported = outcomes.filter(outcome => outcome.status === "import");
  const skipped = outcomes.filter(outcome => outcome.status === "skip");
  const timestamps = sales.map(sale => sale.soldAt.getTime());

  return {
    sales,
    rows: outcomes,
    unknownMenuItems: [...unknownItems.values()].sort((a, b) => b.rowCount - a.rowCount),
    unknownLocations: [...unknownLocations.values()].sort((a, b) => b.rowCount - a.rowCount),
    stats: {
      totalRows: outcomes.length,
      importedRows: imported.length,
      skippedRows: skipped.length,
      duplicateRows: duplicateLines.size,
      saleCount: sales.length,
      totalMillis: sales.reduce((sum, sale) => sum + sale.totalMillis, 0),
      unitsSold: sales.reduce((sum, sale) => sum + sale.lines.reduce((n, line) => n + line.quantity, 0), 0),
      warningRows: imported.filter(outcome => outcome.issues.length > 0).length,
    },
    period: timestamps.length ? { from: new Date(Math.min(...timestamps)), to: new Date(Math.max(...timestamps)) } : null,
  };
}

/** Fields that must be mapped before a plan can be built. */
export function missingRequiredFields(mapping: ColumnMapping): ImportField[] {
  return REQUIRED_FIELDS.filter(field => !mapping[field]);
}

/**
 * Turns a parsed CSV table into pipeline rows.
 *
 * Lives here rather than in each caller so the server and the browser preview
 * number lines identically — an off-by-one between them would have the preview
 * blaming a different row than the error report.
 */
export function rowsFromTable(table: {
  headers: string[];
  rows: string[][];
  ragged: { line: number }[];
}): SourceRow[] {
  const raggedLines = new Set(table.ragged.map(entry => entry.line));

  return table.rows.map((cells, index) => {
    const record: Record<string, string> = {};
    table.headers.forEach((header, column) => {
      record[header] = cells[column] ?? "";
    });
    // +2: one for the header row, one to make it 1-based — the line number the
    // user sees in their spreadsheet.
    const line = index + 2;
    return { line, cells: record, ragged: raggedLines.has(line) };
  });
}

/**
 * Rows that did not import, as a table for the downloadable report.
 *
 * The original cells are echoed back beside the reason, so the file can be
 * corrected in a spreadsheet and re-uploaded directly — which is the point of
 * offering a file at all rather than a list of line numbers.
 */
export function buildErrorReport(plan: ImportPlan, headers: string[]): (string | number)[][] {
  const failed = plan.rows.filter(row => row.status === "skip");
  const table: (string | number)[][] = [["Line", "Problem", ...headers]];

  for (const row of failed) {
    const errors = row.issues.filter(entry => entry.severity === "error");
    const reported = errors.length ? errors : row.issues;
    table.push([
      row.line,
      reported.map(entry => entry.message).join("; "),
      ...headers.map(header => row.cells[header] ?? ""),
    ]);
  }

  return table;
}

// -------------------------------------------------------------- adapter seam

/**
 * The interface a future direct POS integration implements.
 *
 * Nothing implements it yet beyond the CSV path, and that is the point: it fixes
 * the shape now so a Square, Toast or Lightspeed adapter can be added later
 * without touching validation, pricing, idempotency, permissions or the
 * transactional write. An adapter's whole job is to turn whatever the vendor
 * returns into {@link SourceRow}s plus a {@link ColumnMapping} — from there the
 * pipeline is identical to an uploaded file, which means a POS import is
 * previewable, auditable and idempotent for free.
 *
 * The one thing an adapter must guarantee is a stable `externalId` per sale.
 * Given one, re-syncing an overlapping window is a no-op; without one the
 * pipeline falls back to hashing the sale's content, which is stable but cannot
 * survive the vendor editing a historical ticket.
 */
export type SalesImportAdapter = {
  /** Stable identifier stored on every sale this adapter creates, e.g. "square". */
  readonly key: string;
  readonly label: string;
  /** Which `sale_source` the resulting rows carry. */
  readonly source: "csv_import" | "pos_import";
  /** Pulls a window of sales and presents them as rows the pipeline can plan. */
  fetchRows(input: { from: Date; to: Date; locationId: string }): Promise<{ rows: SourceRow[]; mapping: ColumnMapping }>;
};

// -------------------------------------------------------------- sample file

/**
 * The header the sample file uses, and the shape the docs describe.
 *
 * Deliberately snake_case and vendor-neutral: it is an *example* of a workable
 * export, not a required format. `suggestMapping` recognises all six, so the
 * sample maps itself on upload and the user sees the wizard working before they
 * risk their own data.
 */
export const SAMPLE_CSV_HEADERS = ["sale_id", "sold_at", "location", "menu_item", "quantity", "unit_price"] as const;

/**
 * Builds a downloadable example, using the workspace's own menu and locations.
 *
 * Generated rather than shipped as a static file, for one reason: a fixed sample
 * naming "Hamburger" would fail to import for a restaurant that sells none, and
 * the first thing the owner would see is "Menu item not found" on the file we
 * gave them. Drawing the names from their own catalog means the sample imports
 * cleanly — it is a working demonstration, not a picture of one.
 *
 * Prices are the current menu price, formatted in major units the way a till
 * would write them. Dates land on two recent days so the result is visible in
 * the default report range, and two rows share a `sale_id` to show how a
 * multi-line ticket is expressed.
 *
 * The caller labels this clearly as a template. Nothing here imports it.
 */
export function buildSampleCsvRows(
  menuItems: { name: string; sellingPriceMillis: number }[],
  locationName: string,
  currency: string,
  today: Date,
): string[][] {
  const exponent = minorUnitExponent(currency);
  const price = (millis: number) => (millis / 10 ** exponent).toFixed(exponent);

  const day = (offset: number, hour: number, minute: number) => {
    const date = new Date(today);
    date.setDate(date.getDate() - offset);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(hour)}:${pad(minute)}`;
  };

  // Cycles through whatever the workspace has, so a one-dish menu still
  // produces a coherent file.
  const pick = (index: number) => menuItems[index % menuItems.length];

  const rows: string[][] = [[...SAMPLE_CSV_HEADERS]];
  const plan: { ticket: string; offset: number; hour: number; minute: number; item: number; quantity: number }[] = [
    { ticket: "T-1001", offset: 1, hour: 12, minute: 15, item: 0, quantity: 2 },
    // Same ticket, second line: this is how a multi-item order is expressed.
    { ticket: "T-1001", offset: 1, hour: 12, minute: 15, item: 1, quantity: 1 },
    { ticket: "T-1002", offset: 1, hour: 13, minute: 40, item: 2, quantity: 1 },
    { ticket: "T-1003", offset: 0, hour: 19, minute: 5, item: 0, quantity: 3 },
    { ticket: "T-1004", offset: 0, hour: 20, minute: 30, item: 1, quantity: 2 },
  ];

  for (const entry of plan) {
    const item = pick(entry.item);
    rows.push([
      entry.ticket,
      day(entry.offset, entry.hour, entry.minute),
      locationName,
      item.name,
      String(entry.quantity),
      price(item.sellingPriceMillis),
    ]);
  }

  return rows;
}
