import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Money and measurement formatting live in dedicated modules; re-exported here
// because most UI files already import them from `@/lib/utils`.
export { formatMoney, formatMoneyCompact, formatPercent } from "./money";
export { formatQuantity } from "./units";

export function formatDate(value: Date | string, timeZone?: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone }).format(new Date(value));
}

export function formatDateTime(value: Date | string, timeZone?: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone }).format(new Date(value));
}

/** "3 days ago" style label for price-history and activity lists. */
export function formatRelative(value: Date | string) {
  const days = Math.round((new Date(value).getTime() - Date.now()) / 86_400_000);
  if (Math.abs(days) < 1) return "today";
  if (Math.abs(days) < 30) return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(days, "day");
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round(days / 30), "month");
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
