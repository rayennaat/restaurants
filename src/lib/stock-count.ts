/**
 * Stock count variance.
 *
 * Answers one question per ingredient: the ledger says we hold X, the shelf
 * holds Y, so what is the difference worth? Pure functions over already-loaded
 * rows — no database, no I/O — so the arithmetic is directly testable and the
 * same numbers drive the entry screen, the approval summary and the movements
 * written at approval.
 *
 * Money is integer minor units throughout (see `lib/money`). Quantities are
 * floats because that is what `numeric` columns and unit conversion produce,
 * but every currency figure is rounded to an integer exactly once, at the point
 * it is derived from a quantity.
 */

export const STOCK_COUNT_STATUSES = ["draft", "counting", "submitted", "approved", "rejected"] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];

export const STOCK_COUNT_STATUS_LABELS: Record<StockCountStatus, string> = {
  draft: "Draft",
  counting: "Counting",
  submitted: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
};

/** Editable statuses. Terminal counts are frozen by the database as well. */
export function isEditableStatus(status: StockCountStatus) {
  return status === "draft" || status === "counting";
}

export function isTerminalStatus(status: StockCountStatus) {
  return status === "approved" || status === "rejected";
}

export type CountItemInput = {
  ingredientId: string;
  ingredientName: string;
  unit: string;
  /** Ledger balance snapshotted when the line was created, in base units. */
  systemQuantity: number;
  /** Physical count in base units. Null means not yet counted. */
  countedQuantity: number | null;
  /** Cost of one base unit, snapshotted with the line. */
  unitCostMillis: number;
  note?: string | null;
};

export type CountItemVariance = CountItemInput & {
  /** counted − system. Negative means stock is missing. */
  varianceQuantity: number;
  /**
   * Variance as a share of the system quantity, 0-100+. Null when the system
   * held nothing: any positive count against zero is an infinite increase, not
   * a percentage, and printing one would invent a number.
   */
  variancePercent: number | null;
  /** Variance valued at the snapshotted unit cost, in minor units. Signed. */
  varianceValueMillis: number;
  /** False until a physical figure has been entered. */
  isCounted: boolean;
};

/** Prices one counted line. An uncounted line has no variance, not a zero one. */
export function calculateItemVariance(item: CountItemInput): CountItemVariance {
  if (item.countedQuantity === null || !Number.isFinite(item.countedQuantity)) {
    return { ...item, varianceQuantity: 0, variancePercent: null, varianceValueMillis: 0, isCounted: false };
  }

  const varianceQuantity = item.countedQuantity - item.systemQuantity;

  return {
    ...item,
    varianceQuantity,
    variancePercent: item.systemQuantity === 0 ? null : (varianceQuantity / Math.abs(item.systemQuantity)) * 100,
    varianceValueMillis: Math.round(varianceQuantity * item.unitCostMillis),
    isCounted: true,
  };
}

export type CountSummary = {
  itemCount: number;
  countedCount: number;
  /** Counted lines whose physical figure differs from the ledger. */
  varianceCount: number;
  /** Sum of gains, always >= 0. */
  positiveValueMillis: number;
  /** Sum of losses, always <= 0. */
  negativeValueMillis: number;
  /** positive + negative. The bottom line the approver is signing off. */
  netValueMillis: number;
  /** Total absolute movement, which is the better measure of counting accuracy. */
  absoluteValueMillis: number;
  /** True once every line has a physical figure. */
  isComplete: boolean;
};

/**
 * Rolls counted lines into the figures shown on the approval screen.
 *
 * Gains and losses are reported separately as well as netted, because they mean
 * different things: +340 and −580 netting to −240 hides that two different
 * problems are in play. Uncounted lines are excluded entirely rather than
 * treated as zero variance.
 */
export function summarizeCount(items: CountItemVariance[]): CountSummary {
  const counted = items.filter(item => item.isCounted);
  const withVariance = counted.filter(item => item.varianceQuantity !== 0);

  const positiveValueMillis = withVariance
    .filter(item => item.varianceValueMillis > 0)
    .reduce((total, item) => total + item.varianceValueMillis, 0);

  const negativeValueMillis = withVariance
    .filter(item => item.varianceValueMillis < 0)
    .reduce((total, item) => total + item.varianceValueMillis, 0);

  return {
    itemCount: items.length,
    countedCount: counted.length,
    varianceCount: withVariance.length,
    positiveValueMillis,
    negativeValueMillis,
    netValueMillis: positiveValueMillis + negativeValueMillis,
    absoluteValueMillis: positiveValueMillis - negativeValueMillis,
    isComplete: items.length > 0 && counted.length === items.length,
  };
}

/**
 * Lines that will produce a ledger movement when the count is approved.
 *
 * A line counted exactly at its system quantity confirms the ledger and writes
 * nothing — a zero-quantity movement would be noise in the audit trail.
 */
export function adjustableItems(items: CountItemVariance[]) {
  return items.filter(item => item.isCounted && item.varianceQuantity !== 0);
}

/** Worst variances first by absolute value, for the review screen. */
export function rankByVariance(items: CountItemVariance[]) {
  return [...items].sort((a, b) => Math.abs(b.varianceValueMillis) - Math.abs(a.varianceValueMillis));
}

/**
 * Whether a variance is large enough to question rather than absorb.
 *
 * Deliberately based on percentage rather than value: 2 kg missing from 4 kg is
 * a process failure, while the same 2 kg from 400 kg is measurement noise, even
 * though both may cost the same. Lines with no system stock are always flagged,
 * since a percentage cannot be formed.
 */
export function varianceTone(item: CountItemVariance): "neutral" | "warning" | "danger" {
  if (!item.isCounted || item.varianceQuantity === 0) return "neutral";
  if (item.variancePercent === null) return "warning";
  const magnitude = Math.abs(item.variancePercent);
  if (magnitude >= 10) return "danger";
  if (magnitude >= 2) return "warning";
  return "neutral";
}
