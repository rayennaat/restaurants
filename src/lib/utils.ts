import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
export function formatMoney(value: number, currency = "TND") {
  return new Intl.NumberFormat(currency === "TND" ? "fr-TN" : "en-US", { style: "currency", currency, maximumFractionDigits: currency === "TND" ? 3 : 2 }).format(value / (currency === "TND" ? 1000 : 100));
}
export function formatQuantity(value: string | number, unit: string) { return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${unit}`; }
