import { describe, expect, it } from "vitest";
import { summarizeLocationStockAlerts, type LocationStockAlertRow } from "@/server/queries/analytics";

const alert = (overrides: Partial<LocationStockAlertRow>): LocationStockAlertRow => ({
  locationId: "la-marsa",
  locationName: "La Marsa",
  ingredientId: "ingredient",
  ingredientName: "Ingredient",
  unit: "kg",
  stock: 0,
  minimum: 0,
  status: "out",
  ...overrides,
});

describe("all-location stock-health summaries", () => {
  it("keeps every branch alert visible in totals instead of capping La Marsa", () => {
    const alerts = Array.from({ length: 20 }, (_, index) => alert({
      ingredientId: `la-marsa-${index}`,
      ingredientName: `La Marsa ingredient ${index}`,
    }));
    alerts.push(alert({
      locationId: "ariana",
      locationName: "Ariana",
      ingredientId: "ariana-1",
      ingredientName: "Ariana ingredient",
      stock: 0.2,
      minimum: 1,
      status: "low",
    }));

    const summary = summarizeLocationStockAlerts(alerts);

    expect(summary.total).toBe(21);
    expect(summary.out).toBe(20);
    expect(summary.low).toBe(1);
    expect(summary.locations).toEqual([
      { id: "la-marsa", name: "La Marsa", alertCount: 20 },
      { id: "ariana", name: "Ariana", alertCount: 1 },
    ]);
  });
});
