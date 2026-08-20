export function inventoryStockValueMillis(stock: number, unitCostMillis: number): number {
  return Math.round(Math.max(stock, 0) * unitCostMillis);
}
