"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, recipeIngredients, stockMovements } from "@/db/schema";
import { toMinorUnits } from "@/lib/money";
import { ingredientInput } from "@/lib/validation";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { assertCan, requireTenant } from "@/server/tenant";

function revalidateIngredientViews() {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/ingredients");
  revalidatePath("/dashboard/inventory");
  revalidatePath("/dashboard/recipes");
  revalidatePath("/dashboard/menu");
}

/**
 * Creates or updates an ingredient.
 *
 * `unitCost` arrives in major currency units and is stored as
 * `latest_unit_cost_millis`. Editing it here seeds the cost for ingredients you
 * have not purchased yet; receiving a purchase overwrites it with the real
 * invoice price.
 */
export async function saveIngredient(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");
    const values = ingredientInput.parse(input);
    const db = getDb();

    const record = {
      name: values.name,
      sku: values.sku ?? null,
      category: values.category ?? null,
      baseUnitCode: values.baseUnitCode,
      minimumStock: String(values.minimumStock),
      latestUnitCostMillis: toMinorUnits(values.unitCost, tenant.currency),
      isActive: values.isActive,
      updatedAt: new Date(),
    };

    let id = values.id;
    if (id) {
      const [updated] = await db
        .update(ingredients)
        .set(record)
        .where(and(eq(ingredients.id, id), eq(ingredients.organizationId, tenant.organizationId)))
        .returning({ id: ingredients.id });
      if (!updated) return actionError("Ingredient not found.");
    } else {
      const [created] = await db
        .insert(ingredients)
        .values({ ...record, organizationId: tenant.organizationId })
        .returning({ id: ingredients.id });
      id = created.id;
    }

    await recordAudit({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      action: values.id ? "update" : "create",
      entityType: "ingredient",
      entityId: id,
      metadata: { name: values.name, unitCostMillis: record.latestUnitCostMillis },
    });

    revalidateIngredientViews();
    return actionOk({ id: id! });
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Archives (or restores) an ingredient. Ingredients are never hard-deleted
 * because purchases, stock movements and waste entries reference them; archiving
 * hides them from pickers while keeping history intact.
 */
export async function setIngredientArchived(id: string, archived: boolean): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");

    const [updated] = await getDb()
      .update(ingredients)
      .set({ isActive: !archived, updatedAt: new Date() })
      .where(and(eq(ingredients.id, id), eq(ingredients.organizationId, tenant.organizationId)))
      .returning({ id: ingredients.id, name: ingredients.name });
    if (!updated) return actionError("Ingredient not found.");

    await recordAudit({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      action: archived ? "archive" : "restore",
      entityType: "ingredient",
      entityId: id,
      metadata: { name: updated.name },
    });

    revalidateIngredientViews();
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Permanently removes an ingredient. Only allowed while nothing references it,
 * which in practice means a mistyped record created moments ago.
 */
export async function deleteIngredient(id: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");
    const db = getDb();

    const [movement] = await db.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.ingredientId, id)).limit(1);
    const [usedInRecipe] = await db.select({ recipeId: recipeIngredients.recipeId }).from(recipeIngredients).where(eq(recipeIngredients.ingredientId, id)).limit(1);
    if (movement || usedInRecipe) {
      return actionError("This ingredient already has history. Archive it instead so your reports stay accurate.");
    }

    await db.delete(ingredients).where(and(eq(ingredients.id, id), eq(ingredients.organizationId, tenant.organizationId)));
    await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: "delete", entityType: "ingredient", entityId: id });

    revalidateIngredientViews();
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}
