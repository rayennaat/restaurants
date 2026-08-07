import { and, asc, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, stockMovements, supplierProducts, suppliers } from "@/db/schema";
import type { IngredientFilters } from "@/lib/validation";

export type IngredientRow = {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  baseUnitCode: string;
  minimumStock: number;
  unitCostMillis: number;
  isActive: boolean;
  updatedAt: Date;
  /** Balance at the requested location, summed from the stock ledger. */
  stock: number;
  supplierCount: number;
};

/**
 * Ledger balance per ingredient at one location, as a correlated subquery.
 *
 * The inner table gets an explicit `sm` alias and the outer reference is written
 * as a qualified literal. Interpolating a column into a raw `sql` template emits
 * it *unqualified* ("id"), which inside this subquery would bind to
 * stock_movements.id rather than ingredients.id and silently sum to zero.
 */
function stockAtLocation(locationId: string | null) {
  if (!locationId) return sql<string>`0`;
  return sql<string>`(
    select coalesce(sum(sm.quantity), 0)
    from ${stockMovements} sm
    where sm.ingredient_id = "ingredients"."id"
      and sm.location_id = ${locationId}
  )`;
}

export async function listIngredients(organizationId: string, locationId: string | null, filters: Partial<IngredientFilters> = {}): Promise<IngredientRow[]> {
  const db = getDb();
  const conditions = [eq(ingredients.organizationId, organizationId)];

  if (filters.status === "active" || !filters.status) conditions.push(eq(ingredients.isActive, true));
  else if (filters.status === "archived") conditions.push(eq(ingredients.isActive, false));

  if (filters.q) {
    const term = `%${filters.q}%`;
    conditions.push(or(ilike(ingredients.name, term), ilike(ingredients.sku, term), ilike(ingredients.category, term))!);
  }
  if (filters.category) conditions.push(eq(ingredients.category, filters.category));
  if (filters.unit) conditions.push(eq(ingredients.baseUnitCode, filters.unit));

  const stock = stockAtLocation(locationId);
  const supplierCount = sql<string>`(
    select count(*) from ${supplierProducts} sp
    where sp.ingredient_id = "ingredients"."id" and sp.is_active = true
  )`;

  const orderBy = {
    name: asc(ingredients.name),
    cost: desc(ingredients.latestUnitCostMillis),
    stock: asc(stock),
    updated: desc(ingredients.updatedAt),
  }[filters.sort ?? "name"];

  const rows = await db
    .select({
      id: ingredients.id,
      name: ingredients.name,
      sku: ingredients.sku,
      category: ingredients.category,
      baseUnitCode: ingredients.baseUnitCode,
      minimumStock: ingredients.minimumStock,
      unitCostMillis: ingredients.latestUnitCostMillis,
      isActive: ingredients.isActive,
      updatedAt: ingredients.updatedAt,
      stock,
      supplierCount,
    })
    .from(ingredients)
    .where(and(...conditions))
    .orderBy(orderBy);

  const mapped = rows.map(row => ({
    ...row,
    minimumStock: Number(row.minimumStock),
    stock: Number(row.stock),
    supplierCount: Number(row.supplierCount),
  }));

  // Stock filters are applied after aggregation because they compare two
  // derived values rather than plain columns.
  if (filters.stock === "low") return mapped.filter(row => row.stock < row.minimumStock);
  if (filters.stock === "out") return mapped.filter(row => row.stock <= 0);
  return mapped;
}

export async function getIngredient(organizationId: string, id: string) {
  const [row] = await getDb()
    .select()
    .from(ingredients)
    .where(and(eq(ingredients.id, id), eq(ingredients.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

/** Distinct categories in use, for the filter dropdown and datalist suggestions. */
export async function listIngredientCategories(organizationId: string) {
  const rows = await getDb()
    .selectDistinct({ category: ingredients.category })
    .from(ingredients)
    .where(and(eq(ingredients.organizationId, organizationId), isNotNull(ingredients.category)))
    .orderBy(asc(ingredients.category));
  return rows.map(row => row.category!).filter(Boolean);
}

/** Minimal ingredient list for pickers in purchase, recipe and waste forms. */
export type IngredientOption = { id: string; name: string; baseUnitCode: string; unitCostMillis: number; category: string | null };

export async function listIngredientOptions(organizationId: string): Promise<IngredientOption[]> {
  return getDb()
    .select({
      id: ingredients.id,
      name: ingredients.name,
      baseUnitCode: ingredients.baseUnitCode,
      unitCostMillis: ingredients.latestUnitCostMillis,
      category: ingredients.category,
    })
    .from(ingredients)
    .where(and(eq(ingredients.organizationId, organizationId), eq(ingredients.isActive, true)))
    .orderBy(asc(ingredients.name));
}

/** Suppliers that stock a given ingredient, cheapest first — the "where to buy" answer. */
export async function listIngredientSuppliers(organizationId: string, ingredientId: string) {
  const rows = await getDb()
    .select({
      supplierId: suppliers.id,
      supplierName: suppliers.name,
      supplierSku: supplierProducts.supplierSku,
      packQuantity: supplierProducts.packQuantity,
      packUnitCode: supplierProducts.packUnitCode,
      lastPriceMillis: supplierProducts.lastPriceMillis,
      lastPurchasedAt: supplierProducts.lastPurchasedAt,
    })
    .from(supplierProducts)
    .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(and(eq(supplierProducts.organizationId, organizationId), eq(supplierProducts.ingredientId, ingredientId), eq(supplierProducts.isActive, true)))
    .orderBy(asc(supplierProducts.lastPriceMillis));

  return rows.map(row => ({ ...row, packQuantity: Number(row.packQuantity) }));
}
