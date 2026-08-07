"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, menuItems, recipeIngredients, recipes } from "@/db/schema";
import { toMinorUnits } from "@/lib/money";
import { menuItemInput, recipeInput } from "@/lib/validation";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { assertCan, requireTenant } from "@/server/tenant";

function revalidateRecipeViews(recipeId?: string) {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/recipes");
  if (recipeId) revalidatePath(`/dashboard/recipes/${recipeId}`);
  revalidatePath("/dashboard/menu");
}

/**
 * Creates or updates a recipe and its ingredient lines.
 *
 * Lines are replaced wholesale inside the transaction rather than diffed —
 * a recipe is small and its composite primary key makes a delete-then-insert
 * both simpler and safe against partial updates.
 */
export async function saveRecipe(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");
    const values = recipeInput.parse(input);
    const db = getDb();

    // Verify every referenced ingredient belongs to this organization.
    const ingredientIds = [...new Set(values.items.map(item => item.ingredientId))];
    const owned = await db
      .select({ id: ingredients.id })
      .from(ingredients)
      .where(and(eq(ingredients.organizationId, tenant.organizationId), inArray(ingredients.id, ingredientIds)));
    if (owned.length !== ingredientIds.length) return actionError("One or more ingredients could not be found.");

    const recipeId = await db.transaction(async tx => {
      const record = {
        name: values.name,
        yieldQuantity: String(values.yieldQuantity),
        yieldUnitCode: values.yieldUnitCode ?? null,
        notes: values.notes ?? null,
        isActive: values.isActive,
        updatedAt: new Date(),
      };

      let id = values.id;
      if (id) {
        const [updated] = await tx
          .update(recipes)
          .set(record)
          .where(and(eq(recipes.id, id), eq(recipes.organizationId, tenant.organizationId)))
          .returning({ id: recipes.id });
        if (!updated) throw new Error("Recipe not found.");
        await tx.delete(recipeIngredients).where(eq(recipeIngredients.recipeId, id));
      } else {
        const [created] = await tx
          .insert(recipes)
          .values({ ...record, organizationId: tenant.organizationId })
          .returning({ id: recipes.id });
        id = created.id;
      }

      await tx.insert(recipeIngredients).values(
        values.items.map((item, index) => ({
          recipeId: id!,
          ingredientId: item.ingredientId,
          quantity: String(item.quantity),
          unitCode: item.unitCode,
          sortOrder: index,
        })),
      );

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: values.id ? "update" : "create",
          entityType: "recipe",
          entityId: id,
          metadata: { name: values.name, lineCount: values.items.length },
        },
        tx,
      );

      return id!;
    });

    revalidateRecipeViews(recipeId);
    return actionOk({ id: recipeId });
  } catch (error) {
    return toActionError(error);
  }
}

export async function setRecipeArchived(id: string, archived: boolean): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");

    const [updated] = await getDb()
      .update(recipes)
      .set({ isActive: !archived, updatedAt: new Date() })
      .where(and(eq(recipes.id, id), eq(recipes.organizationId, tenant.organizationId)))
      .returning({ id: recipes.id, name: recipes.name });
    if (!updated) return actionError("Recipe not found.");

    await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: archived ? "archive" : "restore", entityType: "recipe", entityId: id, metadata: { name: updated.name } });
    revalidateRecipeViews(id);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteRecipe(id: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");
    const db = getDb();

    const [linked] = await db.select({ id: menuItems.id }).from(menuItems).where(eq(menuItems.recipeId, id)).limit(1);
    if (linked) return actionError("A menu item still uses this recipe. Unlink it first, or archive the recipe instead.");

    await db.delete(recipes).where(and(eq(recipes.id, id), eq(recipes.organizationId, tenant.organizationId)));
    await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: "delete", entityType: "recipe", entityId: id });

    revalidateRecipeViews();
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

/** Creates or updates a menu item and its link to a costed recipe. */
export async function saveMenuItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");
    const values = menuItemInput.parse(input);
    const db = getDb();

    if (values.recipeId) {
      const [recipe] = await db
        .select({ id: recipes.id })
        .from(recipes)
        .where(and(eq(recipes.id, values.recipeId), eq(recipes.organizationId, tenant.organizationId)))
        .limit(1);
      if (!recipe) return actionError("Recipe not found.");
    }

    const record = {
      name: values.name,
      category: values.category ?? null,
      recipeId: values.recipeId ?? null,
      sellingPriceMillis: toMinorUnits(values.sellingPrice, tenant.currency),
      packagingCostMillis: toMinorUnits(values.packagingCost, tenant.currency),
      isActive: values.isActive,
      updatedAt: new Date(),
    };

    let id = values.id;
    if (id) {
      const [updated] = await db
        .update(menuItems)
        .set(record)
        .where(and(eq(menuItems.id, id), eq(menuItems.organizationId, tenant.organizationId)))
        .returning({ id: menuItems.id });
      if (!updated) return actionError("Menu item not found.");
    } else {
      const [created] = await db
        .insert(menuItems)
        .values({ ...record, organizationId: tenant.organizationId })
        .returning({ id: menuItems.id });
      id = created.id;
    }

    await recordAudit({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      action: values.id ? "update" : "create",
      entityType: "menu_item",
      entityId: id,
      metadata: { name: values.name, sellingPriceMillis: record.sellingPriceMillis },
    });

    revalidateRecipeViews();
    return actionOk({ id: id! });
  } catch (error) {
    return toActionError(error);
  }
}

export async function setMenuItemArchived(id: string, archived: boolean): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");

    const [updated] = await getDb()
      .update(menuItems)
      .set({ isActive: !archived, updatedAt: new Date() })
      .where(and(eq(menuItems.id, id), eq(menuItems.organizationId, tenant.organizationId)))
      .returning({ id: menuItems.id });
    if (!updated) return actionError("Menu item not found.");

    await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: archived ? "archive" : "restore", entityType: "menu_item", entityId: id });
    revalidateRecipeViews();
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteMenuItem(id: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");

    await getDb().delete(menuItems).where(and(eq(menuItems.id, id), eq(menuItems.organizationId, tenant.organizationId)));
    await recordAudit({ organizationId: tenant.organizationId, userId: tenant.userId, action: "delete", entityType: "menu_item", entityId: id });

    revalidateRecipeViews();
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}
