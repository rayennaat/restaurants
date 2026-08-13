/**
 * Date range handling for the dashboard and reports.
 *
 * Every time-bounded metric resolves its window here so the KPI cards, charts
 * and reports on a page always describe the same period. A range also carries
 * the immediately preceding window of equal length, which is what the
 * "+12.4% vs previous period" deltas compare against.
 *
 * Ranges are half-open — `from <= occurred_at < to` — so an entry recorded at
 * midnight belongs to exactly one day and never to two.
 */

export const DATE_RANGE_PRESETS = ["today", "yesterday", "last_7_days", "last_30_days", "this_month", "previous_month", "custom"] as const;
export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

export const DATE_RANGE_LABELS: Record<DateRangePreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  this_month: "This month",
  previous_month: "Previous month",
  custom: "Custom range",
};

export const DEFAULT_PRESET: DateRangePreset = "last_30_days";

/** How trend points are bucketed. Chosen from the span so a chart stays readable. */
export type Granularity = "day" | "week" | "month";

export type DateRange = {
  preset: DateRangePreset;
  label: string;
  from: Date;
  /** Exclusive upper bound. */
  to: Date;
  /** Same-length window immediately before `from`, for period-over-period deltas. */
  previousFrom: Date;
  previousTo: Date;
  granularity: Granularity;
};

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function startOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date: Date, months: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

/** Day buckets stay readable to about six weeks; beyond a season, months. */
function granularityFor(from: Date, to: Date): Granularity {
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (days <= 45) return "day";
  if (days <= 182) return "week";
  return "month";
}

function parseIsoDate(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** `Date` -> `YYYY-MM-DD`, the form the URL and `<input type="date">` use. */
export function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function isDateRangePreset(value: unknown): value is DateRangePreset {
  return typeof value === "string" && (DATE_RANGE_PRESETS as readonly string[]).includes(value);
}

/**
 * Turns URL search params into a concrete window.
 *
 * Anything unparseable falls back to the default preset rather than throwing —
 * a hand-edited query string should degrade to a sensible dashboard, not a 500.
 * A custom range with a `to` before its `from` is swapped rather than rejected.
 */
export function resolveDateRange(params: { range?: string; from?: string; to?: string } = {}, now = new Date()): DateRange {
  const preset: DateRangePreset = isDateRangePreset(params.range) ? params.range : DEFAULT_PRESET;
  const today = startOfDay(now);

  let from: Date;
  let to: Date;

  switch (preset) {
    case "today":
      from = today;
      to = addDays(today, 1);
      break;
    case "yesterday":
      from = addDays(today, -1);
      to = today;
      break;
    case "last_7_days":
      from = addDays(today, -6);
      to = addDays(today, 1);
      break;
    case "this_month":
      from = startOfMonth(today);
      to = addMonths(startOfMonth(today), 1);
      break;
    case "previous_month":
      from = addMonths(startOfMonth(today), -1);
      to = startOfMonth(today);
      break;
    case "custom": {
      const parsedFrom = parseIsoDate(params.from);
      const parsedTo = parseIsoDate(params.to);
      if (!parsedFrom || !parsedTo) {
        // Not enough information yet — behave like the default window.
        return resolveDateRange({ range: DEFAULT_PRESET }, now);
      }
      const [start, end] = parsedFrom <= parsedTo ? [parsedFrom, parsedTo] : [parsedTo, parsedFrom];
      from = start;
      // The picker's end date is inclusive; the query bound is exclusive.
      to = addDays(end, 1);
      break;
    }
    case "last_30_days":
    default:
      from = addDays(today, -29);
      to = addDays(today, 1);
      break;
  }

  const span = to.getTime() - from.getTime();
  const label =
    preset === "custom" ? `${toIsoDate(from)} → ${toIsoDate(addDays(to, -1))}` : DATE_RANGE_LABELS[preset];

  return {
    preset,
    label,
    from,
    to,
    // Previous month is compared against the month before it, not a 30-day slide,
    // so "vs previous period" lines up with how a calendar month is read.
    previousFrom: preset === "this_month" || preset === "previous_month" ? addMonths(from, -1) : new Date(from.getTime() - span),
    previousTo: preset === "this_month" || preset === "previous_month" ? from : from,
    granularity: granularityFor(from, to),
  };
}

/**
 * Percentage change between two periods.
 *
 * Returns null when the previous period was zero — there is no meaningful
 * percentage change from nothing, and showing "+100%" would invent a trend.
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

/** Every bucket start in a range, so a trend can be zero-filled for gaps. */
export function bucketStarts(range: DateRange): string[] {
  const keys: string[] = [];
  const cursor = new Date(range.from);

  if (range.granularity === "month") {
    let month = startOfMonth(cursor);
    while (month < range.to) {
      keys.push(toIsoDate(month));
      month = addMonths(month, 1);
    }
    return keys;
  }

  if (range.granularity === "week") {
    // Postgres `date_trunc('week')` starts on Monday; match it exactly or the
    // zero-fill keys will not line up with the grouped rows.
    const day = cursor.getUTCDay();
    const week = addDays(cursor, day === 0 ? -6 : 1 - day);
    let current = week;
    while (current < range.to) {
      keys.push(toIsoDate(current));
      current = addDays(current, 7);
    }
    return keys;
  }

  let current = startOfDay(cursor);
  while (current < range.to) {
    keys.push(toIsoDate(current));
    current = addDays(current, 1);
  }
  return keys;
}

/** Short axis label for a bucket, matched to the range's granularity. */
export function bucketLabel(isoDate: string, granularity: Granularity) {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  if (granularity === "month") return date.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
  if (granularity === "week") return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}
