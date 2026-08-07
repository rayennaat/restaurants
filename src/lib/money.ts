/**
 * Money is stored everywhere as an integer number of minor currency units.
 *
 * The database columns are historically suffixed `...Millis` because the product
 * launched with Tunisian dinar, whose minor unit is the millime (1/1000).
 * For currencies with a 1/100 minor unit the same integer simply means cents.
 * Never do arithmetic on floating point currency values outside this module.
 */

const MINOR_UNIT_EXPONENT: Record<string, number> = { TND: 3, KWD: 3, BHD: 3, OMR: 3, JOD: 3 };

export const SUPPORTED_CURRENCIES = ["TND", "USD", "EUR"] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export function minorUnitExponent(currency: string) {
  return MINOR_UNIT_EXPONENT[currency.toUpperCase()] ?? 2;
}

/** How many minor units make up one major unit. 1000 for TND, 100 for USD. */
export function minorUnitScale(currency: string) {
  return 10 ** minorUnitExponent(currency);
}

/** "18.5" (major units) -> 18500 minor units for TND. */
export function toMinorUnits(amount: number | string, currency: string) {
  const value = typeof amount === "string" ? Number(amount.replace(",", ".")) : amount;
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * minorUnitScale(currency));
}

/** 18500 minor units -> 18.5 major units for TND. */
export function toMajorUnits(minor: number, currency: string) {
  return minor / minorUnitScale(currency);
}

const localeForCurrency: Record<string, string> = { TND: "fr-TN", EUR: "fr-FR", USD: "en-US" };

/** Formats an integer minor-unit amount as localized currency text. */
export function formatMoney(minor: number, currency = "TND") {
  const exponent = minorUnitExponent(currency);
  return new Intl.NumberFormat(localeForCurrency[currency] ?? "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(toMajorUnits(minor, currency));
}

/** Compact form for dense tables and chart axes: "18.5k". */
export function formatMoneyCompact(minor: number, currency = "TND") {
  const major = toMajorUnits(minor, currency);
  const abs = Math.abs(major);
  if (abs >= 1_000_000) return `${(major / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(major / 1_000).toFixed(1)}k`;
  return major.toFixed(minorUnitExponent(currency) === 3 ? 1 : 2);
}

/** Value for a `<input type="number">` bound to a minor-unit integer. */
export function moneyInputValue(minor: number, currency: string) {
  return toMajorUnits(minor, currency).toFixed(minorUnitExponent(currency));
}

/** Smallest increment a money input should step by, e.g. 0.001 for TND. */
export function moneyInputStep(currency: string) {
  return (1 / minorUnitScale(currency)).toFixed(minorUnitExponent(currency));
}

export function formatPercent(value: number, fractionDigits = 1) {
  if (!Number.isFinite(value)) return "—";
  return `${value.toFixed(fractionDigits)}%`;
}
