"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, purchases, supplierProducts, suppliers } from "@/db/schema";
import { toMinorUnits } from "@/lib/money";
import { supplierInput, supplierProductInput } from "@/lib/validation";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { assertCan, requireTenant } from "@/server/tenant";

function revalidateSupplierViews(supplierId?: string) {
  revalidatePath("/dashboard/suppliers");
  if (supplierId) revalidatePath(`/dashboard/suppliers/${supplierId}`);
  revalidatePath("/dashboard/purchases?view=new");
}

export async function saveSupplier(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");
    const values = supplierInput.parse(input);
    const db = getDb();

    const record = {
      name: values.name,
      contactName: values.contactName ?? null,
      phone: values.phone ?? null,
      email: values.email ?? null,
      address: values.address ?? null,
      notes: values.notes ?? null,
      isActive: values.isActive,
      updatedAt: new Date(),
    };

    let id = values.id;
    if (id) {
      const [updated] = await db
        .update(suppliers)
        .set(record)
        .where(and(eq(suppliers.id, id), eq(suppliers.organizationId, tenant.organizationId)))
        .returning({ id: suppliers.id });
      if (!updated) return actionError("Supplier not found.");
    } else {
      const [created] = await db
        .insert(suppliers)
        .values({ ...record, organizationId: tenant.organizationId })
        .returning({ id: suppliers.id });
      id = created.id;
    }

    await recordAudit({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      action: values.id ? "update" : "create",
      entityType: "supplier",
      entityId: id,
      metadata: { name: values.name },
    });

    revalidateSupplierViews(id);
    return actionOk({ id: id! });
  } catch (error) {
    return toActionError(error);
  }
}

export async function setSupplierArchived(id: string, archived: boolean): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");

    const [updated] = await getDb()
      .update(suppliers)
      .set({ isActive: !archived, updatedAt: new Date() })
      .where(and(eq(suppliers.id, id), eq(suppliers.organizationId, tenant.organizationId)))
      .returning({ id: suppliers.id, name: suppliers.name });
    if (!updated) return actionError("Supplier not found.");

    await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: archived ? "archive" : "restore", entityType: "supplier", entityId: id, metadata: { name: updated.name } });
    revalidateSupplierViews(id);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteSupplier(id: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");
    const db = getDb();

    const [purchase] = await db.select({ id: purchases.id }).from(purchases).where(eq(purchases.supplierId, id)).limit(1);
    if (purchase) return actionError("This supplier has invoices on record. Archive it instead so your purchase history stays intact.");

    await db.delete(suppliers).where(and(eq(suppliers.id, id), eq(suppliers.organizationId, tenant.organizationId)));
    await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: "delete", entityType: "supplier", entityId: id });

    revalidateSupplierViews();
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Adds or updates one line of a supplier's catalog.
 *
 * `unitPrice` is what one `packUnitCode` costs. Receiving a purchase overwrites
 * this with the real invoice price, so manual entry here is only the starting
 * point for suppliers you have not bought from yet.
 */
export async function saveSupplierProduct(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");
    const values = supplierProductInput.parse(input);
    const db = getDb();

    const [supplier] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, values.supplierId), eq(suppliers.organizationId, tenant.organizationId)))
      .limit(1);
    if (!supplier) return actionError("Supplier not found.");

    const [ingredient] = await db
      .select({ id: ingredients.id })
      .from(ingredients)
      .where(and(eq(ingredients.id, values.ingredientId), eq(ingredients.organizationId, tenant.organizationId)))
      .limit(1);
    if (!ingredient) return actionError("Ingredient not found.");

    const record = {
      supplierSku: values.supplierSku ?? null,
      packQuantity: String(values.packQuantity),
      packUnitCode: values.packUnitCode,
      lastPriceMillis: toMinorUnits(values.unitPrice, tenant.currency),
      isActive: values.isActive,
      updatedAt: new Date(),
    };

    let id = values.id;
    if (id) {
      const [updated] = await db
        .update(supplierProducts)
        .set(record)
        .where(and(eq(supplierProducts.id, id), eq(supplierProducts.organizationId, tenant.organizationId)))
        .returning({ id: supplierProducts.id });
      if (!updated) return actionError("Supplier product not found.");
    } else {
      // The (supplier, ingredient) unique index makes this an idempotent upsert,
      // so re-adding an existing product refreshes it instead of failing.
      const [created] = await db
        .insert(supplierProducts)
        .values({ ...record, organizationId: tenant.organizationId, supplierId: values.supplierId, ingredientId: values.ingredientId })
        .onConflictDoUpdate({ target: [supplierProducts.supplierId, supplierProducts.ingredientId], set: record })
        .returning({ id: supplierProducts.id });
      id = created.id;
    }

    await recordAudit({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      action: values.id ? "update" : "create",
      entityType: "supplier_product",
      entityId: id,
      metadata: { supplierId: values.supplierId, ingredientId: values.ingredientId, priceMillis: record.lastPriceMillis },
    });

    revalidateSupplierViews(values.supplierId);
    revalidatePath("/dashboard/ingredients");
    return actionOk({ id: id! });
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteSupplierProduct(id: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");

    const [deleted] = await getDb()
      .delete(supplierProducts)
      .where(and(eq(supplierProducts.id, id), eq(supplierProducts.organizationId, tenant.organizationId)))
      .returning({ supplierId: supplierProducts.supplierId });
    if (!deleted) return actionError("Supplier product not found.");

    await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: "delete", entityType: "supplier_product", entityId: id });
    revalidateSupplierViews(deleted.supplierId);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}
