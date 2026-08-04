import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, stockMovements, suppliers, wasteEntries } from "@/db/schema";
import { demoIngredients, demoRecipes, demoSuppliers, demoWasteTrend } from "./demo-data";

export async function getInventory(organizationId: string, locationId: string | null) {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true" || !locationId) return demoIngredients;
  const db = getDb();
  const rows = await db.select({ id: ingredients.id, name: ingredients.name, unit: ingredients.baseUnitCode, minimum: ingredients.minimumStock, unitCostMillis: ingredients.latestUnitCostMillis, stock: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)` }).from(ingredients).leftJoin(stockMovements, and(eq(stockMovements.ingredientId, ingredients.id), eq(stockMovements.locationId, locationId))).where(eq(ingredients.organizationId, organizationId)).groupBy(ingredients.id).orderBy(ingredients.name);
  return rows.map(r => ({ ...r, stock: Number(r.stock), minimum: Number(r.minimum) }));
}
export async function getDashboard(organizationId: string, locationId: string | null) {
  const inventory = await getInventory(organizationId, locationId);
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") return { inventory, wasteTrend: demoWasteTrend, recipes: demoRecipes, stats: { inventoryValue: 6430000, weeklyWaste: 168000, lowStock: inventory.filter(i => i.stock < i.minimum).length, avgMargin: 57.7 } };
  const db = getDb();
  const [waste] = await db.select({ total: sql<number>`coalesce(sum(${wasteEntries.estimatedCostMillis}), 0)` }).from(wasteEntries).where(and(eq(wasteEntries.organizationId, organizationId), sql`${wasteEntries.occurredAt} >= now() - interval '7 days'`));
  const inventoryValue = inventory.reduce((total, item) => total + item.stock * item.unitCostMillis, 0);
  return { inventory, wasteTrend: demoWasteTrend, recipes: [], stats: { inventoryValue, weeklyWaste: Number(waste?.total ?? 0), lowStock: inventory.filter(i => i.stock < i.minimum).length, avgMargin: 0 } };
}
export async function getSuppliers(organizationId: string) { if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") return demoSuppliers; const db = getDb(); return db.select({ id: suppliers.id, name: suppliers.name, phone: suppliers.phone }).from(suppliers).where(eq(suppliers.organizationId, organizationId)).orderBy(desc(suppliers.createdAt)); }
export async function getRecipes() { return demoRecipes; }
