/**
 * Sale pricing arithmetic.
 *
 * Pure functions over already-loaded rows — no database, no I/O — for the same
 * reason `lib/stock-count` and `lib/costing` are pure: the numbers that become
 * revenue are the ones most worth testing directly, and the manual entry path
 * and the coming CSV/POS import path must not each grow their own copy of them.
 *
 * The rule this module exists to enforce is **historical pricing**. A sale line
 * is priced from the catalog row supplied here, snapshotted into the line, and
 * never re-derived afterwards. Re-pricing a burger from 20 DT to 22 DT changes
 * what the next sale costs and nothing about the last one.
 *
 * Money is integer minor units throughout (see `lib/money`). Quantities are
 * floats because `numeric` columns and fractional portions both produce them,
 * so each line total is rounded to an integer exactly once, where the quantity
 * meets the price.
 */

import { ActionError } from "@/lib/action-error";

export const SALE_SOURCES = ["manual", "csv_import", "pos_import"] as const;
export type SaleSource = (typeof SALE_SOURCES)[number];

export const SALE_STATUSES = ["recorded", "voided"] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

/** A menu item as the server resolved it, already scoped to the caller's organization. */
export type PricedMenuItem = {
  id: string;
  name: string;
  sellingPriceMillis: number;
};

/** What the caller asked to record. Deliberately carries no price. */
export type SoldItemInput = {
  menuItemId: string;
  quantity: number;
};

export type BuiltSaleLine = {
  menuItemId: string;
  /** Snapshotted, so a later rename leaves old receipts reading correctly. */
  menuItemName: string;
  quantity: number;
  /** Snapshotted, so a later re-price leaves old revenue untouched. */
  unitPriceMillis: number;
  lineTotalMillis: number;
  sortOrder: number;
};

/**
 * Menu item ids that the catalog does not account for.
 *
 * The caller loads the catalog scoped to its own organization, so an id from
 * another tenant simply fails to resolve and lands here. That makes this the
 * tenant check as much as a validation one, which is why it reports every
 * missing id rather than stopping at the first.
 */
export function findMissingMenuItems(items: SoldItemInput[], catalog: PricedMenuItem[]): string[] {
  const known = new Set(catalog.map(row => row.id));
  const missing = new Set<string>();

  for (const item of items) {
    if (!known.has(item.menuItemId)) missing.add(item.menuItemId);
  }

  return [...missing];
}

/**
 * Prices the lines of a sale and totals them.
 *
 * Lines are returned in the order supplied, with `sortOrder` fixed at build
 * time so the sale reads back the way it was entered. Repeated menu items are
 * *not* merged: a ticket that rang the same dish twice is a faithful record of
 * what happened, and merging would quietly rewrite it.
 *
 * Throws if an item is not in the catalog — {@link findMissingMenuItems} is how
 * a caller turns that into a message naming the offending ids.
 */
export function buildSaleLines(
  items: SoldItemInput[],
  catalog: PricedMenuItem[],
): { lines: BuiltSaleLine[]; totalMillis: number } {
  const byId = new Map(catalog.map(row => [row.id, row]));

  const lines = items.map((item, index) => {
    const menuItem = byId.get(item.menuItemId);
    if (!menuItem) throw new ActionError(`Unknown menu item: ${item.menuItemId}`);

    // The snapshot. Everything downstream reads this rather than the live menu
    // price, which is what preserves historical revenue.
    const unitPriceMillis = menuItem.sellingPriceMillis;

    return {
      menuItemId: item.menuItemId,
      menuItemName: menuItem.name,
      quantity: item.quantity,
      unitPriceMillis,
      lineTotalMillis: Math.round(item.quantity * unitPriceMillis),
      sortOrder: index,
    };
  });

  // Summed from the already-rounded line totals, so the header figure always
  // equals what the printed lines add up to. Totalling the unrounded products
  // instead would be marginally more accurate and visibly wrong on screen.
  return { lines, totalMillis: lines.reduce((total, line) => total + line.lineTotalMillis, 0) };
}

/** Units sold across a sale — audit metadata, and the input to consumption. */
export function totalUnitsSold(items: SoldItemInput[]): number {
  return items.reduce((total, item) => total + item.quantity, 0);
}

// ------------------------------------------------------------------ imports

/**
 * One line of an imported sale, as the import pipeline planned it.
 *
 * Where {@link SoldItemInput} deliberately carries no price — the server is the
 * only party allowed to price a manual entry — an imported line *must* carry
 * one, because preserving the price the till recorded is the entire point of an
 * import. The snapshot rule is still the same: the supplied price is written
 * into the line and never re-derived from the menu afterwards.
 */
export type ImportedSaleLine = {
  menuItemId: string;
  menuItemName: string;
  quantity: number;
  /** As the file said — historical, never the menu's current price. */
  unitPriceMillis: number;
  lineTotalMillis: number;
  sortOrder: number;
};

/**
 * Validates imported lines and builds their snapshot totals.
 *
 * The import pipeline resolves names and prices against the caller's own
 * catalog and never creates dishes; this function trusts that resolution and
 * concentrates on the arithmetic that must never disagree between the two code
 * paths: the line total is quantity × unit price rounded once, and the sale
 * total is the sum of those rounded line totals.
 */
export function buildImportedSaleLines(
  items: ImportedSaleLine[],
  catalog: PricedMenuItem[],
): { lines: BuiltSaleLine[]; totalMillis: number } {
  const byId = new Map(catalog.map(row => [row.id, row]));

  const lines = items.map((item, index) => {
    const menuItem = byId.get(item.menuItemId);
    if (!menuItem) throw new ActionError(`Unknown menu item: ${item.menuItemId}`);

    const lineTotalMillis = Math.round(item.quantity * item.unitPriceMillis);

    return {
      menuItemId: item.menuItemId,
      // The catalog name wins over the file's spelling: a row may have been
      // matched through an alias, and the snapshotted name is what receipts and
      // reports will show.
      menuItemName: menuItem.name,
      quantity: item.quantity,
      unitPriceMillis: item.unitPriceMillis,
      lineTotalMillis,
      sortOrder: index,
    };
  });

  return { lines, totalMillis: lines.reduce((total, line) => total + line.lineTotalMillis, 0) };
}
