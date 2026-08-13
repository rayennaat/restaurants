"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, menuItemLines, menuItems, recipeIngredients, recipes } from "@/db/schema";
import { collectRecipeDependencies } from "@/lib/costing";
import { toMinorUnits } from "@/lib/money";
import { menuItemInput, recipeInput } from "@/lib/validation";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { requirePermission, requireTenant } from "@/server/tenant";
import { ActionError } from "@/lib/action-error";

function revalidateRecipeViews(recipeId?: string) {
  revalidatePath("/dashboard");
  revalidatePath("/dashboard/recipes");
  if (recipeId) revalidatePath(`/dashboard/recipes/${recipeId}`);
  revalidatePath("/dashboard/menu");
}

type RecipeLineValues = { kind: "ingredient" | "recipe"; ingredientId?: string; componentRecipeId?: string; quantity: number; unitCode?: string }[];

/**
 * Confirms every referenced ingredient and preparation belongs to this org, and
 * that adding the preparations would not close a cycle.
 *
 * Shared by preparations and dishes. `editingRecipeId` is passed only when
 * saving a preparation — a dish is a leaf that nothing consumes, so it cannot be
 * part of a cycle and the edge walk is skipped.
 *
 * The database rejects direct self-reference, but A→B→A can only be caught by
 * walking the existing edges, which is what this does. Returns an error result
 * to hand straight back to the caller, or `null` when the lines are sound.
 */
async function validateRecipeLines(organizationId: string, items: RecipeLineValues, editingRecipeId?: string): Promise<ActionResult<never> | null> {
  const db = getDb();
  const ingredientIds = [...new Set(items.flatMap(item => (item.kind === "ingredient" ? [item.ingredientId!] : [])))];
  const componentIds = [...new Set(items.flatMap(item => (item.kind === "recipe" ? [item.componentRecipeId!] : [])))];

  if (ingredientIds.length) {
    const owned = await db
      .select({ id: ingredients.id })
      .from(ingredients)
      .where(and(eq(ingredients.organizationId, organizationId), inArray(ingredients.id, ingredientIds)));
    if (owned.length !== ingredientIds.length) return actionError("One or more ingredients could not be found.");
  }

  if (!componentIds.length) return null;

  const ownedRecipes = await db
    .select({ id: recipes.id, name: recipes.name })
    .from(recipes)
    .where(and(eq(recipes.organizationId, organizationId), inArray(recipes.id, componentIds)));
  if (ownedRecipes.length !== componentIds.length) return actionError("One or more preparations could not be found.");

  if (!editingRecipeId) return null;

  if (componentIds.includes(editingRecipeId)) {
    return actionError("A recipe cannot use itself as a preparation.", { items: "A recipe cannot use itself as a preparation." });
  }

  const edgeRows = await db
    .select({ recipeId: recipeIngredients.recipeId, componentRecipeId: recipeIngredients.componentRecipeId })
    .from(recipeIngredients)
    .innerJoin(recipes, eq(recipes.id, recipeIngredients.recipeId))
    .where(and(eq(recipes.organizationId, organizationId), isNotNull(recipeIngredients.componentRecipeId)));

  const edges = new Map<string, string[]>();
  for (const row of edgeRows) {
    if (!row.componentRecipeId) continue;
    const existing = edges.get(row.recipeId);
    if (existing) existing.push(row.componentRecipeId);
    else edges.set(row.recipeId, [row.componentRecipeId]);
  }

  for (const componentId of componentIds) {
    if (collectRecipeDependencies(componentId, edges).has(editingRecipeId)) {
      const name = ownedRecipes.find(row => row.id === componentId)?.name ?? "That preparation";
      return actionError(`${name} already depends on this recipe, so adding it would create a circular reference.`, { items: `${name} already depends on this recipe.` });
    }
  }

  return null;
}

/**
 * Creates or updates a preparation and its lines.
 *
 * Lines are replaced wholesale inside the transaction rather than diffed — a
 * recipe is small, so delete-then-insert is simpler and safe against partial
 * updates.
 */
export async function saveRecipe(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_recipes");
    const values = recipeInput.parse(input);
    const db = getDb();

    const invalid = await validateRecipeLines(tenant.organizationId, values.items, values.id);
    if (invalid) return invalid;

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
        if (!updated) throw new ActionError("Recipe not found.");
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
          metadata: {
            name: values.name,
            ingredientLines: values.items.filter(item => item.kind === "ingredient").length,
            componentLines: values.items.filter(item => item.kind === "recipe").length,
          },
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
    requirePermission(tenant.role, "manage_recipes");

    const updated = await getDb().transaction(async tx => {
      const [row] = await tx
        .update(recipes)
        .set({ isActive: !archived, updatedAt: new Date() })
        .where(and(eq(recipes.id, id), eq(recipes.organizationId, tenant.organizationId)))
        .returning({ id: recipes.id, name: recipes.name });
      if (!row) return null;

      await recordAudit(
        { organizationId: tenant.organizationId, userId: tenant.userId, action: archived ? "archive" : "restore", entityType: "recipe", entityId: id, metadata: { name: row.name } },
        tx,
      );
      return row;
    });
    if (!updated) return actionError("Recipe not found.");

    revalidateRecipeViews(id);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function deleteRecipe(id: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_recipes");
    const db = getDb();

    /**
     * Ownership first, before anything is looked up *about* the id.
     *
     * The consumer checks below name the recipe or dish that blocks the delete,
     * and they used to run on the id alone. Passing another workspace's recipe id
     * therefore answered with that workspace's recipe name — a cross-tenant read
     * out of an error message. Resolving ownership first means an id this
     * organization does not own gets "Recipe not found." and nothing else.
     */
    const [owned] = await db
      .select({ id: recipes.id })
      .from(recipes)
      .where(and(eq(recipes.id, id), eq(recipes.organizationId, tenant.organizationId)))
      .limit(1);
    if (!owned) return actionError("Recipe not found.");

    // Deleting a preparation something still consumes would silently strip cost
    // from everything above it, so block on either kind of consumer.
    const [usedByRecipe] = await db
      .select({ name: recipes.name })
      .from(recipeIngredients)
      .innerJoin(recipes, eq(recipes.id, recipeIngredients.recipeId))
      .where(and(eq(recipeIngredients.componentRecipeId, id), eq(recipes.organizationId, tenant.organizationId)))
      .limit(1);
    if (usedByRecipe) {
      return actionError(`“${usedByRecipe.name}” uses this as a preparation. Remove it there first, or archive this recipe instead.`);
    }

    const [usedByDish] = await db
      .select({ name: menuItems.name })
      .from(menuItemLines)
      .innerJoin(menuItems, eq(menuItems.id, menuItemLines.menuItemId))
      .where(and(eq(menuItemLines.componentRecipeId, id), eq(menuItems.organizationId, tenant.organizationId)))
      .limit(1);
    if (usedByDish) {
      return actionError(`The menu item “${usedByDish.name}” uses this as a preparation. Remove it there first, or archive this recipe instead.`);
    }

    await db.transaction(async tx => {
      const [deleted] = await tx
        .delete(recipes)
        .where(and(eq(recipes.id, id), eq(recipes.organizationId, tenant.organizationId)))
        .returning({ name: recipes.name });
      if (!deleted) throw new ActionError("Recipe not found.");

      await recordAudit(
        { organizationId: tenant.organizationId, userId: tenant.userId, action: "delete", entityType: "recipe", entityId: id, metadata: { name: deleted.name } },
        tx,
      );
    });

    revalidateRecipeViews();
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Creates or updates a dish and its composition.
 *
 * A menu item owns its lines outright, so there is nothing to share and nothing
 * to fork: the same dish sold at two prices is two menu items, each with its own
 * lines. Item and lines are written in one transaction so a failure can never
 * leave a dish with a price and no composition.
 */
export async function saveMenuItem(input: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_recipes");
    const values = menuItemInput.parse(input);
    const db = getDb();

    // No `editingRecipeId`: a dish is a leaf, so it cannot be part of a cycle.
    const invalid = await validateRecipeLines(tenant.organizationId, values.items);
    if (invalid) return invalid;

    const record = {
      name: values.name,
      category: values.category ?? null,
      yieldQuantity: String(values.yieldQuantity),
      sellingPriceMillis: toMinorUnits(values.sellingPrice, tenant.currency),
      packagingCostMillis: toMinorUnits(values.packagingCost, tenant.currency),
      isActive: values.isActive,
      updatedAt: new Date(),
    };

    const menuItemId = await db.transaction(async tx => {
      let id = values.id;
      if (id) {
        const [updated] = await tx
          .update(menuItems)
          .set(record)
          .where(and(eq(menuItems.id, id), eq(menuItems.organizationId, tenant.organizationId)))
          .returning({ id: menuItems.id });
        if (!updated) throw new ActionError("Menu item not found.");
        await tx.delete(menuItemLines).where(eq(menuItemLines.menuItemId, id));
      } else {
        const [created] = await tx
          .insert(menuItems)
          .values({ ...record, organizationId: tenant.organizationId })
          .returning({ id: menuItems.id });
        id = created.id;
      }

      await tx.insert(menuItemLines).values(
        values.items.map((item, index) => ({
          menuItemId: id!,
          ingredientId: item.kind === "ingredient" ? item.ingredientId! : null,
          componentRecipeId: item.kind === "recipe" ? item.componentRecipeId! : null,
          quantity: String(item.quantity),
          unitCode: item.unitCode ?? null,
          sortOrder: index,
        })),
      );

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: values.id ? "update" : "create",
          entityType: "menu_item",
          entityId: id,
          metadata: {
            name: values.name,
            sellingPriceMillis: record.sellingPriceMillis,
            ingredientLines: values.items.filter(item => item.kind === "ingredient").length,
            componentLines: values.items.filter(item => item.kind === "recipe").length,
          },
        },
        tx,
      );

      return id!;
    });

    revalidateRecipeViews();
    return actionOk({ id: menuItemId });
  } catch (error) {
    return toActionError(error);
  }
}

export async function setMenuItemArchived(id: string, archived: boolean): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_recipes");

    const updated = await getDb().transaction(async tx => {
      const [row] = await tx
        .update(menuItems)
        .set({ isActive: !archived, updatedAt: new Date() })
        .where(and(eq(menuItems.id, id), eq(menuItems.organizationId, tenant.organizationId)))
        .returning({ id: menuItems.id, name: menuItems.name });
      if (!row) return null;

      await recordAudit(
        { organizationId: tenant.organizationId, userId: tenant.userId, action: archived ? "archive" : "restore", entityType: "menu_item", entityId: id, metadata: { name: row.name } },
        tx,
      );
      return row;
    });
    if (!updated) return actionError("Menu item not found.");

    revalidateRecipeViews();
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Deletes a dish. Its lines cascade; the preparations it referenced are shared
 * catalog rows and are left alone.
 */
export async function deleteMenuItem(id: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_recipes");

    const deleted = await getDb().transaction(async tx => {
      const [row] = await tx
        .delete(menuItems)
        .where(and(eq(menuItems.id, id), eq(menuItems.organizationId, tenant.organizationId)))
        .returning({ id: menuItems.id, name: menuItems.name });
      if (!row) return null;

      await recordAudit(
        { organizationId: tenant.organizationId, userId: tenant.userId, action: "delete", entityType: "menu_item", entityId: id, metadata: { name: row.name } },
        tx,
      );
      return row;
    });
    if (!deleted) return actionError("Menu item not found.");

    revalidateRecipeViews();
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}
