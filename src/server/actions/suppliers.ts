"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, purchases, supplierProducts, suppliers } from "@/db/schema";
import { toMinorUnits } from "@/lib/money";
import { supplierInput, supplierProductInput } from "@/lib/validation";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { requirePermission, requireTenant } from "@/server/tenant";
import { ActionError } from "@/lib/action-error";

function revalidateSupplierViews(supplierId?: string) {
  revalidatePath("/dashboard/suppliers");
  if (supplierId) revalidatePath(`/dashboard/suppliers/${supplierId}`);
  revalidatePath("/dashboard/purchases?view=new");
}

export async function saveSupplier(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_suppliers");
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

    const id = await db.transaction(async tx => {
      let savedId = values.id;
      if (savedId) {
        const [updated] = await tx
          .update(suppliers)
          .set(record)
          .where(and(eq(suppliers.id, savedId), eq(suppliers.organizationId, tenant.organizationId)))
          .returning({ id: suppliers.id });
        if (!updated) throw new ActionError("Supplier not found.");
      } else {
        const [created] = await tx
          .insert(suppliers)
          .values({ ...record, organizationId: tenant.organizationId })
          .returning({ id: suppliers.id });
        savedId = created.id;
      }

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: values.id ? "update" : "create",
          entityType: "supplier",
          entityId: savedId,
          metadata: { name: values.name },
        },
        tx,
      );
      return savedId;
    });

    revalidateSupplierViews(id);
    return actionOk({ id });
  } catch (error) {
    return toActionError(error);
  }
}

export async function setSupplierArchived(id: string, archived: boolean): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_suppliers");

    const updated = await getDb().transaction(async tx => {
      const [row] = await tx
        .update(suppliers)
        .set({ isActive: !archived, updatedAt: new Date() })
        .where(and(eq(suppliers.id, id), eq(suppliers.organizationId, tenant.organizationId)))
        .returning({ id: suppliers.id, name: suppliers.name });
      if (!row) return null;

      await recordAudit(
        { organizationId: tenant.organizationId, userId: tenant.userId, action: archived ? "archive" : "restore", entityType: "supplier", entityId: id, metadata: { name: row.name } },
        tx,
      );
      return row;
    });
    if (!updated) return actionError("Supplier not found.");

    revalidateSupplierViews(id);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteSupplier(id: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_suppliers");
    const db = getDb();

    // Ownership before the invoice check, so the answer cannot report whether
    // another workspace's supplier has purchase history.
    const [owned] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(and(eq(suppliers.id, id), eq(suppliers.organizationId, tenant.organizationId)))
      .limit(1);
    if (!owned) return actionError("Supplier not found.");

    const [purchase] = await db
      .select({ id: purchases.id })
      .from(purchases)
      .where(and(eq(purchases.supplierId, id), eq(purchases.organizationId, tenant.organizationId)))
      .limit(1);
    if (purchase) return actionError("This supplier has invoices on record. Archive it instead so your purchase history stays intact.");

    await db.transaction(async tx => {
      const [deleted] = await tx
        .delete(suppliers)
        .where(and(eq(suppliers.id, id), eq(suppliers.organizationId, tenant.organizationId)))
        .returning({ name: suppliers.name });
      if (!deleted) throw new ActionError("Supplier not found.");

      await recordAudit(
        { organizationId: tenant.organizationId, userId: tenant.userId, action: "delete", entityType: "supplier", entityId: id, metadata: { name: deleted.name } },
        tx,
      );
    });

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
    requirePermission(tenant.role, "manage_suppliers");
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

    const id = await db.transaction(async tx => {
      let savedId = values.id;
      if (savedId) {
        const [updated] = await tx
          .update(supplierProducts)
          .set(record)
          .where(and(eq(supplierProducts.id, savedId), eq(supplierProducts.organizationId, tenant.organizationId)))
          .returning({ id: supplierProducts.id });
        if (!updated) throw new ActionError("Supplier product not found.");
      } else {
        // The (supplier, ingredient) unique index makes this an idempotent upsert,
        // so re-adding an existing product refreshes it instead of failing.
        const [created] = await tx
          .insert(supplierProducts)
          .values({ ...record, organizationId: tenant.organizationId, supplierId: values.supplierId, ingredientId: values.ingredientId })
          .onConflictDoUpdate({ target: [supplierProducts.supplierId, supplierProducts.ingredientId], set: record })
          .returning({ id: supplierProducts.id });
        savedId = created.id;
      }

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: values.id ? "update" : "create",
          entityType: "supplier_product",
          entityId: savedId,
          metadata: { supplierId: values.supplierId, ingredientId: values.ingredientId, priceMillis: record.lastPriceMillis },
        },
        tx,
      );
      return savedId;
    });

    revalidateSupplierViews(values.supplierId);
    revalidatePath("/dashboard/ingredients");
    return actionOk({ id });
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteSupplierProduct(id: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_suppliers");

    const deleted = await getDb().transaction(async tx => {
      const [row] = await tx
        .delete(supplierProducts)
        .where(and(eq(supplierProducts.id, id), eq(supplierProducts.organizationId, tenant.organizationId)))
        .returning({ supplierId: supplierProducts.supplierId });
      if (!row) return null;

      await recordAudit(
        { organizationId: tenant.organizationId, userId: tenant.userId, action: "delete", entityType: "supplier_product", entityId: id, metadata: { supplierId: row.supplierId } },
        tx,
      );
      return row;
    });
    if (!deleted) return actionError("Supplier product not found.");

    revalidateSupplierViews(deleted.supplierId);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}
