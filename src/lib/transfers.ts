import { toBaseQuantity, type UnitRow } from "@/lib/units";
import { ActionError } from "@/lib/action-error";

/**
 * Stock transfer rules.
 *
 * Pure functions over already-loaded rows — no database, no I/O — for the same
 * reason `lib/stock-count` and `lib/sales` are pure: these decide whether stock
 * physically moves, and the arithmetic that moves it is worth asserting directly
 * rather than through a round trip.
 *
 * Two things this module exists to keep honest:
 *
 * **Quantities are converted once, here.** A user types "2 dozen" of eggs; the
 * ledger only ever speaks the ingredient's base unit. The conversion uses the
 * existing `lib/units` engine, so a transfer converts exactly the way a purchase
 * and a stock count already do.
 *
 * **Availability is checked against the ledger, not against hope.** Sending more
 * than a site holds would create stock from nothing at the destination, so the
 * shortfall is reported per line, naming what is actually available.
 */

export const TRANSFER_STATUSES = ["draft", "sent", "received", "cancelled"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  draft: "Draft",
  sent: "In transit",
  received: "Received",
  cancelled: "Cancelled",
};

/**
 * `sent` reads as "In transit" on purpose. The status describes the document,
 * but what the user needs to know is where the food is — and between the two
 * legs it is on a van, in neither location's balance.
 */
export const TRANSFER_STATUS_TONES: Record<TransferStatus, "neutral" | "success" | "warning" | "danger"> = {
  draft: "neutral",
  sent: "warning",
  received: "success",
  cancelled: "danger",
};

/** A draft may still be edited; everything else is a historical record. */
export function isEditableTransfer(status: TransferStatus) {
  return status === "draft";
}

/** Whether the goods are on a van: deducted from source, not yet at destination. */
export function isInTransit(status: TransferStatus) {
  return status === "sent";
}

export function isTerminalTransfer(status: TransferStatus) {
  return status === "received" || status === "cancelled";
}

/**
 * Which transitions are legal.
 *
 * Stated as data rather than scattered `if` checks, so the whole lifecycle can
 * be read at once — and so the actions and the UI cannot disagree about what is
 * possible. The database enforces the same thing at write time through a
 * conditional UPDATE, which is what actually prevents a race.
 */
const ALLOWED_TRANSITIONS: Record<TransferStatus, TransferStatus[]> = {
  draft: ["sent", "cancelled"],
  // A sent transfer can still be cancelled — a van turned back at the gate is a
  // real event — and cancelling returns the goods to the source.
  sent: ["received", "cancelled"],
  received: [],
  cancelled: [],
};

export function canTransition(from: TransferStatus, to: TransferStatus) {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ------------------------------------------------------------------- lines

/** A line as the user entered it, before conversion. */
export type TransferLineInput = {
  ingredientId: string;
  /** In `unitCode`, which may be any unit compatible with the ingredient's base. */
  quantity: number;
  unitCode?: string | null;
};

/** An ingredient as the server resolved it, already scoped to the organization. */
export type TransferIngredient = {
  id: string;
  name: string;
  baseUnitCode: string;
  unitCostMillis: number;
};

export type PreparedTransferLine = {
  ingredientId: string;
  ingredientName: string;
  /** As entered, for the document. */
  quantity: number;
  unitCode: string;
  /** Converted into the ingredient's base unit. This is what the ledger records. */
  baseQuantity: number;
  baseUnitCode: string;
  /** Cost of one base unit, snapshotted so the transferred value cannot drift. */
  unitCostMillis: number;
  /** baseQuantity × unitCostMillis, for the document's total. */
  valueMillis: number;
  sortOrder: number;
};

/**
 * Ingredient ids the catalog does not account for.
 *
 * The caller loads the catalog scoped to its own organization, so an id from
 * another tenant simply fails to resolve and lands here. That makes this the
 * cross-tenant check as much as a validation one — and it reports every missing
 * id rather than stopping at the first, so a bad request is explained in full.
 */
export function findMissingIngredients(lines: TransferLineInput[], catalog: TransferIngredient[]): string[] {
  const known = new Set(catalog.map(row => row.id));
  const missing = new Set<string>();
  for (const line of lines) {
    if (!known.has(line.ingredientId)) missing.add(line.ingredientId);
  }
  return [...missing];
}

/**
 * Converts entered lines into the base-unit quantities the ledger needs.
 *
 * Throws if an ingredient is not in the catalog — {@link findMissingIngredients}
 * is how a caller turns that into a message naming the offending ids.
 */
export function prepareTransferLines(
  lines: TransferLineInput[],
  catalog: TransferIngredient[],
  units: UnitRow[],
): PreparedTransferLine[] {
  const byId = new Map(catalog.map(row => [row.id, row]));

  return lines.map((line, index) => {
    const ingredient = byId.get(line.ingredientId);
    if (!ingredient) throw new ActionError(`Unknown ingredient: ${line.ingredientId}`);

    const unitCode = line.unitCode ?? ingredient.baseUnitCode;
    const baseQuantity = toBaseQuantity(line.quantity, unitCode, ingredient.baseUnitCode, units);

    return {
      ingredientId: ingredient.id,
      ingredientName: ingredient.name,
      quantity: line.quantity,
      unitCode,
      baseQuantity,
      baseUnitCode: ingredient.baseUnitCode,
      unitCostMillis: ingredient.unitCostMillis,
      // Rounded once, where the quantity meets the cost, matching how sale
      // lines and count variances are valued.
      valueMillis: Math.round(baseQuantity * ingredient.unitCostMillis),
      sortOrder: index,
    };
  });
}

/** Total value of a prepared transfer, in minor currency units. */
export function transferValueMillis(lines: PreparedTransferLine[]) {
  return lines.reduce((total, line) => total + line.valueMillis, 0);
}

// ----------------------------------------------------------- availability

export type StockShortfall = {
  ingredientId: string;
  ingredientName: string;
  baseUnitCode: string;
  /** What the source location actually holds, in base units. */
  available: number;
  /** What the transfer asks for, in base units. */
  requested: number;
  /** requested − available, always > 0. */
  shortBy: number;
};

/**
 * Lines the source location cannot cover.
 *
 * Checked against the ledger balance for the *source* location specifically —
 * an organization-wide total would happily approve moving beef out of a site
 * that has none, because another site does.
 *
 * A tiny epsilon absorbs float noise from unit conversion: 999.9999999 g of a
 * 1 kg holding is not a real shortfall, and reporting it as one would block a
 * legitimate transfer for a rounding artifact.
 */
export function findShortfalls(
  lines: PreparedTransferLine[],
  availableByIngredient: Map<string, number>,
  epsilon = 1e-6,
): StockShortfall[] {
  const shortfalls: StockShortfall[] = [];

  // Two lines for one ingredient are prevented by a unique index, but summing
  // defensively means this stays correct if that ever changes.
  const requestedByIngredient = new Map<string, number>();
  for (const line of lines) {
    requestedByIngredient.set(line.ingredientId, (requestedByIngredient.get(line.ingredientId) ?? 0) + line.baseQuantity);
  }

  for (const line of lines) {
    const requested = requestedByIngredient.get(line.ingredientId) ?? line.baseQuantity;
    // Already reported for an earlier line of the same ingredient.
    if (shortfalls.some(entry => entry.ingredientId === line.ingredientId)) continue;

    const available = availableByIngredient.get(line.ingredientId) ?? 0;
    if (requested - available > epsilon) {
      shortfalls.push({
        ingredientId: line.ingredientId,
        ingredientName: line.ingredientName,
        baseUnitCode: line.baseUnitCode,
        available,
        requested,
        shortBy: requested - available,
      });
    }
  }

  return shortfalls;
}

/** Human-readable summary of what is missing, for an error message. */
export function describeShortfalls(shortfalls: StockShortfall[]): string {
  return shortfalls
    .map(entry => {
      const round = (value: number) => Number(value.toFixed(3)).toLocaleString();
      return `${entry.ingredientName}: asked for ${round(entry.requested)} ${entry.baseUnitCode}, only ${round(entry.available)} available`;
    })
    .join("; ");
}
