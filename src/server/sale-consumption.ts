import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ingredients, menuItemLines, menuItems, stockMovements } from "@/db/schema";
import { expandMenuItemConsumption, type MenuItemRequirement } from "@/lib/consumption";
import type { MenuGraphNode } from "@/lib/costing";
import type { UnitRow } from "@/lib/units";
import { getPreparationGraph } from "@/server/queries/recipes";

/**
 * Posting sale consumption into the stock ledger.
 *
 * When a dish is sold its ingredients leave the kitchen, so a sale writes one
 * negative `sale_consumption` movement per ingredient the recipe expands to.
 * This is the single place that happens — manual entry, CSV import and any
 * future POS adapter all call {@link postSaleConsumption}, so there is exactly
 * one definition of "what selling a burger does to stock".
 *
 * ## Why this is a movement and not just a report
 *
 * Without it, on-hand stock only ever rises: purchases add, waste subtracts, and
 * the largest real outflow — selling the food — is invisible. Every stock count
 * then reports the entire expected usage of the period as variance, which is
 * exactly the signal a count exists to isolate.
 *
 * ## What keeps variance meaningful
 *
 * A `sale_consumption` movement is an *inference* from a recipe; `purchase`,
 * `waste` and `stock_count_adjustment` are observations. The movement type keeps
 * the two separable, and variance stays honest because it compares the ledger
 * against a quantity a human physically counted — a number the ledger does not
 * feed. So the comparison is still between two independent sources; what changed
 * is that the ledger side now means "what we should be holding" rather than
 * "everything we ever bought".
 *
 * ## Idempotency
 *
 * Movements are tied to their sale through `referenceType`/`referenceId`, and
 * {@link postSaleConsumption} is called exactly once inside the transaction that
 * creates the sale. Re-importing a file cannot double-post because the sale
 * itself is deduped by `(organization, source, external_id)` before this is
 * reached — no sale row, no consumption. Voiding reverses through
 * {@link reverseSaleConsumption} rather than deleting, so the ledger stays
 * append-only and the correction is visible.
 */

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** What one sale sold, as the caller already resolved it. */
export type SoldLine = { menuItemId: string; quantity: number };

/**
 * Per-portion ingredient requirements for the organization's whole menu.
 *
 * Loaded once and reused across every sale in an import, since a file of 5,000
 * rows would otherwise rebuild the same recipe graph 5,000 times. Composed from
 * the same `expandMenuItemConsumption` the reports use, so a change to a recipe
 * reaches posting and reporting together.
 *
 * Scoped to one organization throughout: the menu, its lines and the ingredient
 * costs are all filtered by `organizationId`, so a dish from another tenant
 * cannot appear in the expansion and therefore cannot move another tenant's
 * stock.
 */
export async function loadConsumptionRequirements(
  organizationId: string,
  units: UnitRow[],
  tx?: Tx,
): Promise<Map<string, MenuItemRequirement[]>> {
  const db = tx ?? getDb();

  // Every dish, including archived ones: a sale of a since-retired dish still
  // consumed its ingredients.
  const dishes = await db
    .select({ id: menuItems.id, name: menuItems.name, yieldQuantity: menuItems.yieldQuantity })
    .from(menuItems)
    .where(eq(menuItems.organizationId, organizationId));

  if (!dishes.length) return new Map();

  const lines = await db
    .select({
      menuItemId: menuItemLines.menuItemId,
      ingredientId: menuItemLines.ingredientId,
      componentRecipeId: menuItemLines.componentRecipeId,
      quantity: menuItemLines.quantity,
      unitCode: menuItemLines.unitCode,
      ingredientName: ingredients.name,
      baseUnitCode: ingredients.baseUnitCode,
      unitCostMillis: ingredients.latestUnitCostMillis,
    })
    .from(menuItemLines)
    .leftJoin(ingredients, eq(ingredients.id, menuItemLines.ingredientId))
    .where(inArray(menuItemLines.menuItemId, dishes.map(dish => dish.id)));

  const linesByDish = new Map<string, typeof lines>();
  for (const line of lines) {
    const existing = linesByDish.get(line.menuItemId);
    if (existing) existing.push(line);
    else linesByDish.set(line.menuItemId, [line]);
  }

  const menuNodes: MenuGraphNode[] = dishes.map(dish => ({
    id: dish.id,
    name: dish.name,
    yieldQuantity: Number(dish.yieldQuantity),
    // A line targets exactly one of an ingredient or a preparation (enforced by
    // a check constraint); anything else is skipped rather than guessed at.
    lines: (linesByDish.get(dish.id) ?? []).flatMap((line): MenuGraphNode["lines"] => {
      if (line.componentRecipeId) {
        return [{
          kind: "recipe",
          componentRecipeId: line.componentRecipeId,
          componentName: "",
          quantity: Number(line.quantity),
          unitCode: line.unitCode,
        }];
      }
      if (line.ingredientId) {
        return [{
          kind: "ingredient",
          ingredientId: line.ingredientId,
          ingredientName: line.ingredientName ?? "",
          quantity: Number(line.quantity),
          unitCode: line.unitCode,
          baseUnitCode: line.baseUnitCode ?? "",
          unitCostMillis: line.unitCostMillis ?? 0,
        }];
      }
      return [];
    }),
  }));

  const preparations = await getPreparationGraph(organizationId);
  return expandMenuItemConsumption(menuNodes, preparations, units);
}

/** A movement this sale will write, before it is stringified for the database. */
export type PlannedConsumption = {
  ingredientId: string;
  /** Negative: stock leaving the kitchen. In the ingredient's base unit. */
  quantity: number;
  unitCostMillis: number;
};

/**
 * Expands sold dishes into the ingredient quantities they consume.
 *
 * Pure, so the arithmetic is testable without a database. Quantities come back
 * negative because that is what the ledger stores — a balance is `sum(quantity)`
 * with no per-type sign rules, so getting the sign right here is what makes the
 * balance correct everywhere.
 *
 * Dishes with no composition contribute nothing rather than zero rows: an
 * uncosted dish has no known ingredient demand, and inventing one would be worse
 * than reporting none. The reports already surface that case as `unmappedUnits`.
 */
export function planSaleConsumption(
  soldLines: SoldLine[],
  requirements: Map<string, MenuItemRequirement[]>,
): PlannedConsumption[] {
  const byIngredient = new Map<string, PlannedConsumption>();

  for (const line of soldLines) {
    if (!(line.quantity > 0)) continue;
    const needed = requirements.get(line.menuItemId);
    if (!needed?.length) continue;

    for (const requirement of needed) {
      const consumed = requirement.quantityPerUnit * line.quantity;
      if (!consumed) continue;

      const existing = byIngredient.get(requirement.ingredientId);
      if (existing) {
        existing.quantity -= consumed;
        continue;
      }
      byIngredient.set(requirement.ingredientId, {
        ingredientId: requirement.ingredientId,
        quantity: -consumed,
        unitCostMillis: requirement.unitCostMillis,
      });
    }
  }

  // A dish appearing twice on one ticket is one demand on one shelf, so the
  // rows are merged above and emitted once per ingredient.
  return [...byIngredient.values()].filter(row => row.quantity !== 0);
}

/**
 * Writes the consumption movements for one sale.
 *
 * Must be called inside the transaction that creates the sale, so a rolled-back
 * sale takes its stock movements with it. Returns how many movements were
 * written, which the caller records in its audit metadata.
 */
export async function postSaleConsumption(
  tx: Tx,
  input: {
    organizationId: string;
    locationId: string;
    saleId: string;
    soldAt: Date;
    performedBy: string | null;
    soldLines: SoldLine[];
    requirements: Map<string, MenuItemRequirement[]>;
  },
): Promise<number> {
  const planned = planSaleConsumption(input.soldLines, input.requirements);
  if (!planned.length) return 0;

  await tx.insert(stockMovements).values(
    planned.map(row => ({
      organizationId: input.organizationId,
      locationId: input.locationId,
      ingredientId: row.ingredientId,
      type: "sale_consumption" as const,
      quantity: String(row.quantity),
      unitCostMillis: row.unitCostMillis,
      referenceType: "sale",
      referenceId: input.saleId,
      performedBy: input.performedBy,
      // Dated to the sale, not to now: an import backfilling last month must
      // deplete stock on the day the food actually left the kitchen.
      occurredAt: input.soldAt,
    })),
  );

  return planned.length;
}

/**
 * Reverses the consumption of a voided sale.
 *
 * Writes opposite movements rather than deleting the originals, because the
 * ledger is append-only: a void is a correction that should remain visible, and
 * deleting would erase the fact that stock once moved. Reads the sale's own
 * movements rather than re-expanding the recipe, so a recipe edited between the
 * sale and the void cannot make the reversal disagree with what was posted.
 */
export async function reverseSaleConsumption(
  tx: Tx,
  input: { organizationId: string; saleId: string; performedBy: string | null },
): Promise<number> {
  const posted = await tx
    .select({
      locationId: stockMovements.locationId,
      ingredientId: stockMovements.ingredientId,
      quantity: stockMovements.quantity,
      unitCostMillis: stockMovements.unitCostMillis,
    })
    .from(stockMovements)
    .where(
      and(
        // Scoped to the organization as well as the sale: `referenceId` alone
        // would trust an id supplied by the caller.
        eq(stockMovements.organizationId, input.organizationId),
        eq(stockMovements.referenceId, input.saleId),
        // Only what this sale posted. `referenceType` excludes the reversal
        // rows themselves, so voiding twice cannot re-credit the stock — and
        // the type guard keeps any future movement referencing a sale out of
        // the reversal.
        eq(stockMovements.referenceType, "sale"),
        eq(stockMovements.type, "sale_consumption"),
      ),
    );

  const consumption = posted.filter(row => Number(row.quantity) !== 0);
  if (!consumption.length) return 0;

  await tx.insert(stockMovements).values(
    consumption.map(row => ({
      organizationId: input.organizationId,
      locationId: row.locationId,
      ingredientId: row.ingredientId,
      type: "sale_consumption" as const,
      // Negated, so the pair sums to zero and the balance returns to where it
      // was before the sale.
      quantity: String(-Number(row.quantity)),
      unitCostMillis: row.unitCostMillis,
      referenceType: "sale_void",
      referenceId: input.saleId,
      performedBy: input.performedBy,
    })),
  );

  return consumption.length;
}
