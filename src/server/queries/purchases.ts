import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, locations, purchaseItems, purchases, suppliers } from "@/db/schema";
import type { InferSelectModel } from "drizzle-orm";

export type PurchaseListRow = {
  id: string;
  invoiceNumber: string | null;
  status: string;
  totalMillis: number;
  receivedAt: Date;
  itemCount: number;
  supplierName: string | null;
  locationName: string;
};

export async function listPurchases(organizationId: string, options: { locationId?: string | null; supplierId?: string; limit?: number } = {}) {
  const db = getDb();
  const conditions = [eq(purchases.organizationId, organizationId)];
  if (options.locationId) conditions.push(eq(purchases.locationId, options.locationId));
  if (options.supplierId) conditions.push(eq(purchases.supplierId, options.supplierId));

  const rows = await db
    .select({
      id: purchases.id,
      invoiceNumber: purchases.invoiceNumber,
      status: purchases.status,
      totalMillis: purchases.totalMillis,
      receivedAt: purchases.receivedAt,
      itemCount: db.$count(purchaseItems, eq(purchaseItems.purchaseId, purchases.id)),
      supplierName: suppliers.name,
      locationName: locations.name,
    })
    .from(purchases)
    .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .innerJoin(locations, eq(locations.id, purchases.locationId))
    .where(and(...conditions))
    .orderBy(desc(purchases.receivedAt))
    .limit(options.limit ?? 50);

  return rows;
}

export type PurchaseDetail = {
  id: string;
  invoiceNumber: string | null;
  status: string;
  totalMillis: number;
  notes: string | null;
  receivedAt: Date;
  supplierId: string | null;
  supplierName: string | null;
  locationId: string;
  locationName: string;
  createdBy: string | null;
  items: PurchaseDetailItem[];
};

export type PurchaseDetailItem = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  baseUnitCode: string;
  quantity: number;
  unitCode: string | null;
  unitCostMillis: number;
  lineTotalMillis: number;
  baseQuantity: number | null;
  baseUnitCostMillis: number | null;
};

export async function getPurchase(organizationId: string, id: string): Promise<PurchaseDetail | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: purchases.id,
      invoiceNumber: purchases.invoiceNumber,
      status: purchases.status,
      totalMillis: purchases.totalMillis,
      notes: purchases.notes,
      receivedAt: purchases.receivedAt,
      supplierId: purchases.supplierId,
      supplierName: suppliers.name,
      locationId: purchases.locationId,
      locationName: locations.name,
      createdBy: purchases.createdBy,
    })
    .from(purchases)
    .leftJoin(suppliers, eq(suppliers.id, purchases.supplierId))
    .innerJoin(locations, eq(locations.id, purchases.locationId))
    .where(and(eq(purchases.id, id), eq(purchases.organizationId, organizationId)))
    .limit(1);

  if (!row) return null;

  const items = await db
    .select({
      id: purchaseItems.id,
      ingredientId: purchaseItems.ingredientId,
      ingredientName: ingredients.name,
      baseUnitCode: ingredients.baseUnitCode,
      quantity: purchaseItems.quantity,
      unitCode: purchaseItems.unitCode,
      unitCostMillis: purchaseItems.unitCostMillis,
      lineTotalMillis: purchaseItems.lineTotalMillis,
      baseQuantity: purchaseItems.baseQuantity,
      baseUnitCostMillis: purchaseItems.baseUnitCostMillis,
    })
    .from(purchaseItems)
    .innerJoin(ingredients, eq(ingredients.id, purchaseItems.ingredientId))
    .where(eq(purchaseItems.purchaseId, id))
    .orderBy(asc(purchaseItems.sortOrder), asc(ingredients.name));

  return {
    ...row,
    items: items.map(item => ({
      ...item,
      quantity: Number(item.quantity),
      baseQuantity: item.baseQuantity ? Number(item.baseQuantity) : null,
    })),
  };
}
