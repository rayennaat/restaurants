import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inventoryStockValueMillis } from "@/lib/inventory-valuation";

const analytics = readFileSync(path.join(process.cwd(), "src/server/queries/analytics.ts"), "utf8");

const movements = [
  { locationId: "kitchen", type: "purchase", quantity: 20 },
  { locationId: "kitchen", type: "waste", quantity: -2 },
  { locationId: "kitchen", type: "sale_consumption", quantity: -3 },
  { locationId: "kitchen", type: "transfer_out", quantity: -4 },
  { locationId: "bar", type: "transfer_in", quantity: 4 },
] as const;

function netStock(locationId?: string) {
  return movements
    .filter(movement => !locationId || movement.locationId === locationId)
    .reduce((total, movement) => total + movement.quantity, 0);
}

describe("inventory valuation from the signed movement ledger", () => {
  it("nets purchases, waste, sales consumption and transfer movements before valuation", () => {
    expect(netStock("kitchen")).toBe(11);
    expect(netStock("bar")).toBe(4);
    expect(inventoryStockValueMillis(netStock("kitchen"), 1_000)).toBe(11_000);
    expect(inventoryStockValueMillis(netStock("bar"), 1_000)).toBe(4_000);
  });

  it("makes transfer-out and transfer-in value-neutral across locations", () => {
    const withoutTransfer = movements
      .filter(movement => movement.type !== "transfer_out" && movement.type !== "transfer_in")
      .reduce((total, movement) => total + movement.quantity, 0);

    expect(netStock()).toBe(withoutTransfer);
  });

  it("reconciles the sum of location values with all-locations inventory value", () => {
    const locationTotal = ["kitchen", "bar"].reduce(
      (total, locationId) => total + inventoryStockValueMillis(netStock(locationId), 1_000),
      0,
    );

    expect(locationTotal).toBe(inventoryStockValueMillis(netStock(), 1_000));
  });

  it("floors a negative final balance only after all signed movements are netted", () => {
    expect(inventoryStockValueMillis(-3, 1_000)).toBe(0);
  });
});

describe("per-location inventory SQL", () => {
  const locationQuery = analytics.slice(analytics.indexOf("export async function getInventoryValueByLocation"));

  it("groups signed ledger quantities by location and ingredient", () => {
    expect(locationQuery).toMatch(/stock:\s*sql<string>`coalesce\(sum\(\$\{stockMovements\.quantity\}\), 0\)`/);
    expect(locationQuery).toMatch(/groupBy\(locations\.id, locations\.name, stockMovements\.ingredientId/);
  });

  it("does not value positive movements independently", () => {
    expect(locationQuery).not.toMatch(/greatest\(\$\{stockMovements\.quantity\}, 0\)/);
    expect(locationQuery).not.toMatch(/sum\(greatest/);
  });

  it("shares the canonical final-stock valuation rule", () => {
    const references = analytics.match(/inventoryStockValueMillis\(/g) ?? [];
    expect(references).toHaveLength(2);
    expect(locationQuery).toMatch(/inventoryStockValueMillis\(toNumber\(row\.stock\), row\.unitCostMillis\)/);
  });
});
