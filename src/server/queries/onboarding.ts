import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, menuItems, purchases, recipes, suppliers } from "@/db/schema";

export type SetupStepKey = "ingredient" | "supplier" | "purchase";

export type SetupStep = {
  key: SetupStepKey;
  order: number;
  title: string;
  description: string;
  /** What the owner gets out of finishing this step. */
  payoff: string;
  href: string;
  count: number;
  isComplete: boolean;
};

export type SetupProgress = {
  steps: SetupStep[];
  completedCount: number;
  totalCount: number;
  percent: number;
  /** True once every step has real data behind it. */
  allStepsComplete: boolean;
  /** The step the owner should work on next, or null when finished. */
  nextStep: SetupStep | null;
  counts: { ingredients: number; suppliers: number; recipes: number; purchases: number; menuItems: number };
};

/**
 * The guided setup: buy something, from someone, and record it.
 *
 * Recipes are deliberately not a setup step — they need ingredients that
 * already have real costs, so they belong to normal use after the first
 * invoice has populated pricing.
 */
const STEP_DEFINITIONS: Omit<SetupStep, "count" | "isComplete">[] = [
  {
    key: "ingredient",
    order: 1,
    title: "Add your first ingredient",
    description: "Ingredients are what you buy and count. Give each one a base unit, a minimum stock level and what it currently costs you.",
    payoff: "Unlocks inventory tracking and low-stock alerts.",
    href: "/dashboard/ingredients",
  },
  {
    key: "supplier",
    order: 2,
    title: "Add your first supplier",
    description: "Record who you buy from, then list the products they sell you with their SKU and pack size.",
    payoff: "Unlocks price comparison and supplier price history.",
    href: "/dashboard/suppliers",
  },
  {
    key: "purchase",
    order: 3,
    title: "Record your first purchase",
    description: "Enter a real supplier invoice with all of its lines. Stock and ingredient costs update automatically.",
    payoff: "Puts real stock on hand and starts your cost history.",
    href: "/dashboard/purchases?view=new",
  },
];

/**
 * Derives setup progress from real rows rather than a stored checklist, so the
 * wizard reflects what actually exists in the workspace and stays correct even
 * if the owner creates records outside the guided flow.
 */
export async function getSetupProgress(organizationId: string): Promise<SetupProgress> {
  const db = getDb();
  const scoped = (table: typeof ingredients | typeof suppliers | typeof recipes | typeof menuItems) =>
    db.select({ count: sql<number>`count(*)::int` }).from(table).where(eq(table.organizationId, organizationId));

  const [[ingredientRow], [supplierRow], [recipeRow], [menuItemRow], [purchaseRow]] = await Promise.all([
    scoped(ingredients),
    scoped(suppliers),
    scoped(recipes),
    scoped(menuItems),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(purchases)
      .where(and(eq(purchases.organizationId, organizationId), eq(purchases.status, "received"))),
  ]);

  const counts = {
    ingredients: ingredientRow?.count ?? 0,
    suppliers: supplierRow?.count ?? 0,
    recipes: recipeRow?.count ?? 0,
    menuItems: menuItemRow?.count ?? 0,
    purchases: purchaseRow?.count ?? 0,
  };

  const countFor: Record<SetupStepKey, number> = {
    ingredient: counts.ingredients,
    supplier: counts.suppliers,
    purchase: counts.purchases,
  };

  const steps = STEP_DEFINITIONS.map(definition => ({ ...definition, count: countFor[definition.key], isComplete: countFor[definition.key] > 0 }));
  const completedCount = steps.filter(step => step.isComplete).length;

  return {
    steps,
    completedCount,
    totalCount: steps.length,
    percent: Math.round((completedCount / steps.length) * 100),
    allStepsComplete: completedCount === steps.length,
    nextStep: steps.find(step => !step.isComplete) ?? null,
    counts,
  };
}
