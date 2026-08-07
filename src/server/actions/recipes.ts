"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, menuItems, recipeIngredients, recipes } from "@/db/schema";
import { collectRecipeDependencies } from "@/lib/costing";
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
 * Creates or updates a recipe, its ingredient lines and its sub-recipe lines.
 *
 * Lines are replaced wholesale inside the transaction rather than diffed — a
 * recipe is small, so delete-then-insert is simpler and safe against partial
 * updates. Sub-recipe references are checked for cycles first: the database
 * rejects direct self-reference, but A→B→A can only be caught here.
 */
export async function saveRecipe(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const tenant = await requireTenant();
    assertCan(tenant.role, "manage_catalog");
    const values = recipeInput.parse(input);
    const db = getDb();

    const ingredientIds = [...new Set(values.items.flatMap(item => (item.kind === "ingredient" ? [item.ingredientId!] : [])))];
    const componentIds = [...new Set(values.items.flatMap(item => (item.kind === "recipe" ? [item.componentRecipeId!] : [])))];

    if (ingredientIds.length) {
      const owned = await db
        .select({ id: ingredients.id })
        .from(ingredients)
        .where(and(eq(ingredients.organizationId, tenant.organizationId), inArray(ingredients.id, ingredientIds)));
      if (owned.length !== ingredientIds.length) return actionError("One or more ingredients could not be found.");
    }

    if (componentIds.length) {
      const ownedRecipes = await db
        .select({ id: recipes.id, name: recipes.name })
        .from(recipes)
        .where(and(eq(recipes.organizationId, tenant.organizationId), inArray(recipes.id, componentIds)));
      if (ownedRecipes.length !== componentIds.length) return actionError("One or more preparations could not be found.");

      if (values.id) {
        if (componentIds.includes(values.id)) {
          return actionError("A recipe cannot use itself as a preparation.", { items: "A recipe cannot use itself as a preparation." });
        }

        // Walk the existing graph: if any chosen component already depends on
        // this recipe, adding it would close a loop that cannot be costed.
        const edgeRows = await db
          .select({ recipeId: recipeIngredients.recipeId, componentRecipeId: recipeIngredients.componentRecipeId })
          .from(recipeIngredients)
          .innerJoin(recipes, eq(recipes.id, recipeIngredients.recipeId))
          .where(and(eq(recipes.organizationId, tenant.organizationId), isNotNull(recipeIngredients.componentRecipeId)));

        const edges = new Map<string, string[]>();
        for (const row of edgeRows) {
          if (!row.componentRecipeId) continue;
          const existing = edges.get(row.recipeId);
          if (existing) existing.push(row.componentRecipeId);
          else edges.set(row.recipeId, [row.componentRecipeId]);
        }

        for (const componentId of componentIds) {
          const dependencies = collectRecipeDependencies(componentId, edges);
          if (dependencies.has(values.id)) {
            const name = ownedRecipes.find(row => row.id === componentId)?.name ?? "That preparation";
            return actionError(`${name} already depends on this recipe, so adding it would create a circular reference.`, {
              items: `${name} already depends on this recipe.`,
            });
          }
        }
      }
    }

    const recipeId = await db.transaction(async tx => {
      const record = {
        name: values.name,
        yieldQuantity: String(values.yieldQuantity),
        yieldUnitCode: values.yieldUnitCode ?? null,
        isPreparation: values.isPreparation,
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
          ingredientId: item.kind === "ingredient" ? item.ingredientId! : null,
          componentRecipeId: item.kind === "recipe" ? item.componentRecipeId! : null,
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
          metadata: { name: values.name, ingredientLines: ingredientIds.length, componentLines: componentIds.length, isPreparation: values.isPreparation },
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

    // Deleting a preparation that other recipes consume would strip cost from
    // every dish above it, so block that too.
    const [usedAsComponent] = await db
      .select({ recipeName: recipes.name })
      .from(recipeIngredients)
      .innerJoin(recipes, eq(recipes.id, recipeIngredients.recipeId))
      .where(eq(recipeIngredients.componentRecipeId, id))
      .limit(1);
    if (usedAsComponent) {
      return actionError(`“${usedAsComponent.recipeName}” uses this as a preparation. Remove it there first, or archive this recipe instead.`);
    }

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
