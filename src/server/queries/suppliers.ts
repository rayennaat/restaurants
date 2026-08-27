import { and, asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, purchaseItems, purchases, supplierProducts, suppliers } from "@/db/schema";

export type SupplierListRow = {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  productCount: number;
  pricePointCount: number;
  /** Lifetime spend across received invoices. */
  totalSpendMillis: number;
  purchaseCount: number;
  lastPurchaseAt: Date | null;
};

export async function listSuppliers(organizationId: string, filters: { q?: string; status?: "active" | "archived" | "all" } = {}): Promise<SupplierListRow[]> {
  const conditions = [eq(suppliers.organizationId, organizationId)];
  if (!filters.status || filters.status === "active") conditions.push(eq(suppliers.isActive, true));
  else if (filters.status === "archived") conditions.push(eq(suppliers.isActive, false));
  if (filters.q) {
    const term = `%${filters.q}%`;
    conditions.push(or(ilike(suppliers.name, term), ilike(suppliers.contactName, term), ilike(suppliers.email, term), ilike(suppliers.phone, term))!);
  }

  const rows = await getDb()
    .select({
      id: suppliers.id,
      name: suppliers.name,
      contactName: suppliers.contactName,
      phone: suppliers.phone,
      email: suppliers.email,
      address: suppliers.address,
      notes: suppliers.notes,
      isActive: suppliers.isActive,
      // List and detail use the same sources: active catalog rows plus products
      // and price points proven by received invoices. The outer columns stay
      // qualified because unqualified names would bind inside the subqueries.
      productCount: sql<string>`(
        select count(distinct product.ingredient_id)
        from (
          select sp.ingredient_id
          from ${supplierProducts} sp
          where sp.organization_id = "suppliers"."organization_id"
            and sp.supplier_id = "suppliers"."id"
            and sp.is_active = true
          union all
          select pi.ingredient_id
          from ${purchaseItems} pi
          join ${purchases} p on p.id = pi.purchase_id
          where p.organization_id = "suppliers"."organization_id"
            and p.supplier_id = "suppliers"."id"
            and p.status = 'received'
        ) product
      )`,
      pricePointCount: sql<string>`(
        select count(*)
        from ${purchaseItems} pi
        join ${purchases} p on p.id = pi.purchase_id
        where p.organization_id = "suppliers"."organization_id"
          and p.supplier_id = "suppliers"."id"
          and p.status = 'received'
      )`,
      totalSpendMillis: sql<string>`(select coalesce(sum(p.total_millis), 0) from ${purchases} p where p.supplier_id = "suppliers"."id" and p.status = 'received')`,
      purchaseCount: sql<string>`(select count(*) from ${purchases} p where p.supplier_id = "suppliers"."id" and p.status = 'received')`,
      lastPurchaseAt: sql<Date | null>`(select max(p.received_at) from ${purchases} p where p.supplier_id = "suppliers"."id" and p.status = 'received')`,
    })
    .from(suppliers)
    .where(and(...conditions))
    .orderBy(asc(suppliers.name));

  return rows.map(row => ({
    ...row,
    productCount: Number(row.productCount),
    pricePointCount: Number(row.pricePointCount),
    totalSpendMillis: Number(row.totalSpendMillis),
    purchaseCount: Number(row.purchaseCount),
    lastPurchaseAt: row.lastPurchaseAt ? new Date(row.lastPurchaseAt) : null,
  }));
}

export async function getSupplier(organizationId: string, id: string) {
  const [row] = await getDb()
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, id), eq(suppliers.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

export type SupplierDetailMetrics = { productCount: number; pricePointCount: number };

/** Supplier detail counts derived from both explicit catalog rows and received invoice history. */
export async function getSupplierDetailMetrics(organizationId: string, supplierId: string): Promise<SupplierDetailMetrics> {
  const [row] = await getDb().execute<{ product_count: string; price_point_count: string }>(sql`
    with catalog_products as (
      select sp.ingredient_id
      from ${supplierProducts} sp
      where sp.organization_id = ${organizationId}
        and sp.supplier_id = ${supplierId}
        and sp.is_active = true
    ),
    invoice_products as (
      select pi.ingredient_id
      from ${purchaseItems} pi
      join ${purchases} p on p.id = pi.purchase_id
      where p.organization_id = ${organizationId}
        and p.supplier_id = ${supplierId}
        and p.status = 'received'
    )
    select
      (select count(distinct ingredient_id) from (select ingredient_id from catalog_products union all select ingredient_id from invoice_products) products) as product_count,
      (select count(*) from invoice_products) as price_point_count
  `);

  return {
    productCount: Number(row?.product_count ?? 0),
    pricePointCount: Number(row?.price_point_count ?? 0),
  };
}
export type SupplierProductRow = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  baseUnitCode: string;
  supplierSku: string | null;
  packQuantity: number;
  packUnitCode: string | null;
  lastPriceMillis: number;
  lastPurchasedAt: Date | null;
  isActive: boolean;
  updatedAt: Date;
  /** Ingredient's current cost, so the catalog can flag stale supplier prices. */
  ingredientCostMillis: number;
};

/** Everything a supplier sells, with the price we last paid. */
export async function listSupplierProducts(organizationId: string, supplierId: string): Promise<SupplierProductRow[]> {
  const rows = await getDb()
    .select({
      id: supplierProducts.id,
      ingredientId: supplierProducts.ingredientId,
      ingredientName: ingredients.name,
      baseUnitCode: ingredients.baseUnitCode,
      supplierSku: supplierProducts.supplierSku,
      packQuantity: supplierProducts.packQuantity,
      packUnitCode: supplierProducts.packUnitCode,
      lastPriceMillis: supplierProducts.lastPriceMillis,
      lastPurchasedAt: supplierProducts.lastPurchasedAt,
      isActive: supplierProducts.isActive,
      updatedAt: supplierProducts.updatedAt,
      ingredientCostMillis: ingredients.latestUnitCostMillis,
    })
    .from(supplierProducts)
    .innerJoin(ingredients, eq(ingredients.id, supplierProducts.ingredientId))
    .where(and(eq(supplierProducts.organizationId, organizationId), eq(supplierProducts.supplierId, supplierId)))
    .orderBy(asc(ingredients.name));

  return rows.map(row => ({ ...row, packQuantity: Number(row.packQuantity) }));
}

export type PriceHistoryPoint = {
  purchaseId: string;
  ingredientId: string;
  ingredientName: string;
  receivedAt: Date;
  invoiceNumber: string | null;
  quantity: number;
  unitCode: string | null;
  unitCostMillis: number;
  /** Normalised to the ingredient base unit so points are comparable. */
  baseUnitCostMillis: number;
  baseUnitCode: string;
};

/**
 * Price history is derived from `purchase_items` rather than stored separately —
 * the invoices you already recorded are the source of truth for what you paid.
 */
export async function getSupplierPriceHistory(organizationId: string, supplierId: string, options: { ingredientId?: string; limit?: number } = {}) {
  const conditions = [eq(purchases.organizationId, organizationId), eq(purchases.supplierId, supplierId), eq(purchases.status, "received")];
  if (options.ingredientId) conditions.push(eq(purchaseItems.ingredientId, options.ingredientId));

  const rows = await getDb()
    .select({
      purchaseId: purchases.id,
      ingredientId: purchaseItems.ingredientId,
      ingredientName: ingredients.name,
      receivedAt: purchases.receivedAt,
      invoiceNumber: purchases.invoiceNumber,
      quantity: purchaseItems.quantity,
      unitCode: purchaseItems.unitCode,
      unitCostMillis: purchaseItems.unitCostMillis,
      baseUnitCostMillis: purchaseItems.baseUnitCostMillis,
      baseUnitCode: ingredients.baseUnitCode,
    })
    .from(purchaseItems)
    .innerJoin(purchases, eq(purchases.id, purchaseItems.purchaseId))
    .innerJoin(ingredients, eq(ingredients.id, purchaseItems.ingredientId))
    .where(and(...conditions))
    .orderBy(desc(purchases.receivedAt))
    .limit(options.limit ?? 100);

  return rows.map(row => ({
    ...row,
    quantity: Number(row.quantity),
    // Older rows predate the base-cost column; fall back to the invoice price.
    baseUnitCostMillis: row.baseUnitCostMillis ?? row.unitCostMillis,
  })) as PriceHistoryPoint[];
}

export type SupplierComparisonRow = {
  ingredientId: string;
  ingredientName: string;
  baseUnitCode: string;
  offers: { supplierId: string; supplierName: string; lastPriceMillis: number; packUnitCode: string | null; lastPurchasedAt: Date | null }[];
  cheapestSupplierId: string;
  savingsMillis: number;
};

/**
 * Ingredients offered by more than one supplier, with the spread between the
 * cheapest and dearest — the "which supplier is cheapest" answer.
 */
export async function getSupplierComparison(organizationId: string): Promise<SupplierComparisonRow[]> {
  const rows = await getDb()
    .select({
      ingredientId: supplierProducts.ingredientId,
      ingredientName: ingredients.name,
      baseUnitCode: ingredients.baseUnitCode,
      supplierId: suppliers.id,
      supplierName: suppliers.name,
      lastPriceMillis: supplierProducts.lastPriceMillis,
      packUnitCode: supplierProducts.packUnitCode,
      lastPurchasedAt: supplierProducts.lastPurchasedAt,
    })
    .from(supplierProducts)
    .innerJoin(ingredients, eq(ingredients.id, supplierProducts.ingredientId))
    .innerJoin(suppliers, eq(suppliers.id, supplierProducts.supplierId))
    .where(and(eq(supplierProducts.organizationId, organizationId), eq(supplierProducts.isActive, true), eq(suppliers.isActive, true), sql`${supplierProducts.lastPriceMillis} > 0`))
    .orderBy(asc(ingredients.name), asc(supplierProducts.lastPriceMillis));

  const grouped = new Map<string, SupplierComparisonRow>();
  for (const row of rows) {
    const existing = grouped.get(row.ingredientId);
    const offer = { supplierId: row.supplierId, supplierName: row.supplierName, lastPriceMillis: row.lastPriceMillis, packUnitCode: row.packUnitCode, lastPurchasedAt: row.lastPurchasedAt };
    if (existing) existing.offers.push(offer);
    else grouped.set(row.ingredientId, { ingredientId: row.ingredientId, ingredientName: row.ingredientName, baseUnitCode: row.baseUnitCode, offers: [offer], cheapestSupplierId: row.supplierId, savingsMillis: 0 });
  }

  return [...grouped.values()]
    .filter(row => row.offers.length > 1)
    .map(row => {
      const prices = row.offers.map(offer => offer.lastPriceMillis);
      return { ...row, cheapestSupplierId: row.offers[0].supplierId, savingsMillis: Math.max(...prices) - Math.min(...prices) };
    })
    .sort((a, b) => b.savingsMillis - a.savingsMillis);
}

export type SupplierOption = { id: string; name: string };

/** Supplier picker options for the purchase invoice builder. */
export async function listSupplierOptions(organizationId: string): Promise<SupplierOption[]> {
  return getDb()
    .select({ id: suppliers.id, name: suppliers.name })
    .from(suppliers)
    .where(and(eq(suppliers.organizationId, organizationId), eq(suppliers.isActive, true)))
    .orderBy(asc(suppliers.name));
}

export type SupplierProductOption = { supplierId: string; ingredientId: string; supplierSku: string | null; packQuantity: number; packUnitCode: string | null; lastPriceMillis: number };

/** Supplier catalog entries keyed for the invoice builder's price prefill. */
export async function listSupplierProductLookup(organizationId: string): Promise<SupplierProductOption[]> {
  const rows = await getDb()
    .select({
      supplierId: supplierProducts.supplierId,
      ingredientId: supplierProducts.ingredientId,
      supplierSku: supplierProducts.supplierSku,
      packQuantity: supplierProducts.packQuantity,
      packUnitCode: supplierProducts.packUnitCode,
      lastPriceMillis: supplierProducts.lastPriceMillis,
    })
    .from(supplierProducts)
    .where(and(eq(supplierProducts.organizationId, organizationId), eq(supplierProducts.isActive, true)));

  return rows.map(row => ({ ...row, packQuantity: Number(row.packQuantity) }));
}
