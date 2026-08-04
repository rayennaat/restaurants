export type RecipeLine = { quantityInBaseUnit: number; unitCostMillis: number };
export function calculateRecipeCost(lines: RecipeLine[]) {
  return Math.round(lines.reduce((total, line) => total + line.quantityInBaseUnit * line.unitCostMillis, 0));
}
export function calculateMargin(sellingPriceMillis: number, costMillis: number) {
  if (sellingPriceMillis <= 0) return 0;
  return ((sellingPriceMillis - costMillis) / sellingPriceMillis) * 100;
}
export function convertToBaseUnit(quantity: number, multiplierToBase: number) { return quantity * multiplierToBase; }
