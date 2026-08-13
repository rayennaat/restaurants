/**
 * Display labels for the `waste_reason` enum.
 *
 * Shared so the waste log, dashboard breakdown and waste report all name a
 * reason identically — the enum values themselves are storage identifiers and
 * should never reach the screen.
 */
export const WASTE_REASON_LABELS: Record<string, string> = {
  expired: "Expired",
  damaged: "Damaged",
  overproduction: "Overproduction",
  preparation_error: "Preparation error",
  quality_issue: "Quality issue",
  other: "Other",
};

export function wasteReasonLabel(reason: string | null | undefined) {
  if (!reason) return "—";
  return WASTE_REASON_LABELS[reason] ?? reason;
}

/**
 * Reasons a manager can act on directly. Expiry and overproduction point at
 * ordering and prep decisions; a quality issue points at the supplier.
 */
export const ACTIONABLE_WASTE_REASONS = new Set(["expired", "overproduction", "preparation_error"]);
