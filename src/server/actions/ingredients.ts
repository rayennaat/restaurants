"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, menuItemLines, menuItems, recipeIngredients, recipes, stockMovements } from "@/db/schema";
import { toMinorUnits } from "@/lib/money";
import { ingredientInput } from "@/lib/validation";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { requirePermission, requireTenant } from "@/server/tenant";
import { ActionError } from "@/lib/action-error";

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
    requirePermission(tenant.role, "manage_ingredients");
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

    const id = await db.transaction(async tx => {
      let savedId = values.id;
      if (savedId) {
        const [updated] = await tx
          .update(ingredients)
          .set(record)
          .where(and(eq(ingredients.id, savedId), eq(ingredients.organizationId, tenant.organizationId)))
          .returning({ id: ingredients.id });
        if (!updated) throw new ActionError("Ingredient not found.");
      } else {
        const [created] = await tx
          .insert(ingredients)
          .values({ ...record, organizationId: tenant.organizationId })
          .returning({ id: ingredients.id });
        savedId = created.id;
      }

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: values.id ? "update" : "create",
          entityType: "ingredient",
          entityId: savedId,
          metadata: { name: values.name, unitCostMillis: record.latestUnitCostMillis },
        },
        tx,
      );
      return savedId;
    });

    revalidateIngredientViews();
    return actionOk({ id });
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
    requirePermission(tenant.role, "manage_ingredients");

    // Transactional: archiving hides an ingredient from every picker, so the
    // record of who did it must not be able to vanish on its own.
    const updated = await getDb().transaction(async tx => {
      const [row] = await tx
        .update(ingredients)
        .set({ isActive: !archived, updatedAt: new Date() })
        .where(and(eq(ingredients.id, id), eq(ingredients.organizationId, tenant.organizationId)))
        .returning({ id: ingredients.id, name: ingredients.name });
      if (!row) return null;

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: archived ? "archive" : "restore",
          entityType: "ingredient",
          entityId: id,
          metadata: { name: row.name },
        },
        tx,
      );
      return row;
    });
    if (!updated) return actionError("Ingredient not found.");

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
    requirePermission(tenant.role, "manage_ingredients");
    const db = getDb();

    // Ownership before history: the three checks below would otherwise report
    // whether an id belonging to another workspace has movements or is used in a
    // recipe there — a yes/no oracle about data the caller cannot see.
    const [owned] = await db
      .select({ id: ingredients.id })
      .from(ingredients)
      .where(and(eq(ingredients.id, id), eq(ingredients.organizationId, tenant.organizationId)))
      .limit(1);
    if (!owned) return actionError("Ingredient not found.");

    const [movement] = await db
      .select({ id: stockMovements.id })
      .from(stockMovements)
      .where(and(eq(stockMovements.ingredientId, id), eq(stockMovements.organizationId, tenant.organizationId)))
      .limit(1);
    const [usedInRecipe] = await db
      .select({ recipeId: recipeIngredients.recipeId })
      .from(recipeIngredients)
      .innerJoin(recipes, eq(recipes.id, recipeIngredients.recipeId))
      .where(and(eq(recipeIngredients.ingredientId, id), eq(recipes.organizationId, tenant.organizationId)))
      .limit(1);
    const [usedInDish] = await db
      .select({ menuItemId: menuItemLines.menuItemId })
      .from(menuItemLines)
      .innerJoin(menuItems, eq(menuItems.id, menuItemLines.menuItemId))
      .where(and(eq(menuItemLines.ingredientId, id), eq(menuItems.organizationId, tenant.organizationId)))
      .limit(1);
    if (movement || usedInRecipe || usedInDish) {
      return actionError("This ingredient already has history. Archive it instead so your reports stay accurate.");
    }

    await db.transaction(async tx => {
      const [deleted] = await tx
        .delete(ingredients)
        .where(and(eq(ingredients.id, id), eq(ingredients.organizationId, tenant.organizationId)))
        .returning({ name: ingredients.name });
      if (!deleted) throw new ActionError("Ingredient not found.");

      await recordAudit(
        { organizationId: tenant.organizationId, userId: tenant.userId, action: "delete", entityType: "ingredient", entityId: id, metadata: { name: deleted.name } },
        tx,
      );
    });

    revalidateIngredientViews();
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}
