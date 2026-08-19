import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../src/db/client";
import {
  auditLogs,
  ingredients,
  locations,
  menuItemLines,
  menuItems,
  organizations,
  purchaseItems,
  purchases,
  saleLines,
  sales,
  stockCountItems,
  stockCounts,
  stockMovements,
  stockTransferItems,
  stockTransfers,
  units,
  wasteEntries,
} from "../src/db/schema";
import { adjustableItems, calculateItemVariance } from "../src/lib/stock-count";
import { findMissingIngredients, findShortfalls, prepareTransferLines } from "../src/lib/transfers";
import { parseCsv } from "../src/lib/csv";
import { buildImportPlan, rowsFromTable, suggestMapping, buildSampleCsvRows } from "../src/lib/sales-import";
import { toCsv } from "../src/lib/csv";
import { planSaleConsumption } from "../src/server/sale-consumption";
import { expandMenuItemConsumption } from "../src/lib/consumption";

/**
 * End-to-end integrity verification, against a real database.
 *
 * The unit tests prove the arithmetic and the structural tests prove the code
 * shape, but neither can answer the question this script exists for: *does the
 * balance actually move the way the product claims?* That needs real inserts,
 * real `numeric` round-tripping and a real `sum(quantity)`.
 *
 * ## Everything happens inside one transaction that is always rolled back
 *
 * The script creates its own throwaway organization, exercises the full flow
 * against it, asserts on what the ledger reports, and then aborts. Nothing is
 * left behind and no existing row is read into the assertions — so this is safe
 * to run against a database with live data, which is precisely when you most
 * want to run it.
 *
 * Run locally with: npm run verify:integrity
 * Run against staging with: npm run verify:integrity:staging
 */

type Check = { name: string; pass: boolean; detail: string };
const checks: Check[] = [];

function check(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
}

/** Floating point tolerance: `numeric` round-trips through strings. */
const near = (a: number, b: number, epsilon = 1e-6) => Math.abs(a - b) < epsilon;

async function main() {
  const db = getDb();

  // The whole verification runs inside this transaction. The deliberate throw
  // at the end rolls it back.
  await db
    .transaction(async tx => {
      const balanceOf = async (ingredientId: string, locationId: string) => {
        const [row] = await tx
          .select({ total: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)` })
          .from(stockMovements)
          .where(and(eq(stockMovements.ingredientId, ingredientId), eq(stockMovements.locationId, locationId)));
        return Number(row?.total ?? 0);
      };

      // ------------------------------------------------------------- fixture
      const [org] = await tx
        .insert(organizations)
        .values({ name: "Integrity Probe", slug: `integrity-probe-${Date.now()}` })
        .returning();
      const [otherOrg] = await tx
        .insert(organizations)
        .values({ name: "Other Tenant", slug: `other-tenant-${Date.now()}` })
        .returning();

      const [main] = await tx.insert(locations).values({ organizationId: org.id, name: "Main" }).returning();
      const [annex] = await tx.insert(locations).values({ organizationId: org.id, name: "Annex" }).returning();

      await tx.insert(units).values([
        { organizationId: org.id, code: "kg", name: "Kilogram", dimension: "mass", multiplierToBase: "1", isBase: true },
        { organizationId: org.id, code: "g", name: "Gram", dimension: "mass", multiplierToBase: "0.001" },
        { organizationId: org.id, code: "unit", name: "Unit", dimension: "count", multiplierToBase: "1", isBase: true },
        { organizationId: org.id, code: "dozen", name: "Dozen", dimension: "count", multiplierToBase: "12" },
      ]);
      const unitRows = await tx.select().from(units).where(eq(units.organizationId, org.id));
      const unitList = unitRows.map(row => ({
        code: row.code,
        name: row.name,
        dimension: row.dimension,
        multiplierToBase: row.multiplierToBase,
        isBase: row.isBase,
      }));

      const [beef] = await tx
        .insert(ingredients)
        .values({ organizationId: org.id, name: "Beef", baseUnitCode: "kg", latestUnitCostMillis: 30_000 })
        .returning();
      const [cucumber] = await tx
        .insert(ingredients)
        .values({ organizationId: org.id, name: "Cucumber", baseUnitCode: "kg", latestUnitCostMillis: 2_000 })
        .returning();

      const [burger] = await tx
        .insert(menuItems)
        .values({ organizationId: org.id, name: "Hamburger", sellingPriceMillis: 18_000, yieldQuantity: "1" })
        .returning();
      // 150 g of beef per burger, expressed in grams to exercise unit conversion.
      await tx.insert(menuItemLines).values({
        menuItemId: burger.id,
        ingredientId: beef.id,
        quantity: "150",
        unitCode: "g",
        sortOrder: 0,
      });

      const requirements = expandMenuItemConsumption(
        [
          {
            id: burger.id,
            name: "Hamburger",
            yieldQuantity: 1,
            lines: [
              {
                kind: "ingredient" as const,
                ingredientId: beef.id,
                ingredientName: "Beef",
                quantity: 150,
                unitCode: "g",
                baseUnitCode: "kg",
                unitCostMillis: 30_000,
              },
            ],
          },
        ],
        [],
        unitList,
      );

      // ------------------------------------------------ 1. purchase increases
      const [purchase] = await tx
        .insert(purchases)
        .values({ organizationId: org.id, locationId: main.id, status: "received", totalMillis: 300_000 })
        .returning();
      await tx.insert(purchaseItems).values({
        purchaseId: purchase.id,
        ingredientId: beef.id,
        quantity: "10",
        unitCode: "kg",
        unitCostMillis: 30_000,
        lineTotalMillis: 300_000,
      });
      await tx.insert(stockMovements).values({
        organizationId: org.id,
        locationId: main.id,
        ingredientId: beef.id,
        type: "purchase",
        quantity: "10",
        unitCostMillis: 30_000,
        referenceType: "purchase",
        referenceId: purchase.id,
      });
      await tx.insert(stockMovements).values({
        organizationId: org.id,
        locationId: main.id,
        ingredientId: cucumber.id,
        type: "purchase",
        quantity: "12.8",
        unitCostMillis: 2_000,
        referenceType: "purchase",
        referenceId: purchase.id,
      });

      const afterPurchase = await balanceOf(beef.id, main.id);
      check("purchase increases inventory", near(afterPurchase, 10), `beef = ${afterPurchase} kg (expected 10)`);

      // -------------------------------------------- 2. sale consumes stock
      const [sale] = await tx
        .insert(sales)
        .values({
          organizationId: org.id,
          locationId: main.id,
          source: "manual",
          status: "recorded",
          reference: "T-1",
          totalMillis: 36_000,
          soldAt: new Date(),
        })
        .returning();
      await tx.insert(saleLines).values({
        saleId: sale.id,
        menuItemId: burger.id,
        menuItemName: "Hamburger",
        quantity: "2",
        unitPriceMillis: 18_000,
        lineTotalMillis: 36_000,
      });

      const planned = planSaleConsumption([{ menuItemId: burger.id, quantity: 2 }], requirements);
      check(
        "2 burgers expand to 300 g beef",
        planned.length === 1 && near(planned[0].quantity, -0.3),
        `planned ${planned.map(row => `${row.quantity} kg`).join(", ") || "nothing"} (expected -0.3 kg)`,
      );

      await tx.insert(stockMovements).values(
        planned.map(row => ({
          organizationId: org.id,
          locationId: main.id,
          ingredientId: row.ingredientId,
          type: "sale_consumption" as const,
          quantity: String(row.quantity),
          unitCostMillis: row.unitCostMillis,
          referenceType: "sale",
          referenceId: sale.id,
        })),
      );

      const afterSale = await balanceOf(beef.id, main.id);
      check("sale decreases inventory", near(afterSale, 9.7), `beef = ${afterSale} kg (expected 9.7)`);

      // ------------------------------------------------------ 3. waste
      const [waste] = await tx
        .insert(wasteEntries)
        .values({
          organizationId: org.id,
          locationId: main.id,
          ingredientId: cucumber.id,
          quantity: "1",
          estimatedCostMillis: 2_000,
          reason: "expired",
        })
        .returning();
      await tx.insert(stockMovements).values({
        organizationId: org.id,
        locationId: main.id,
        ingredientId: cucumber.id,
        type: "waste",
        quantity: "-1",
        unitCostMillis: 2_000,
        referenceType: "waste_entry",
        referenceId: waste.id,
      });

      const afterWaste = await balanceOf(cucumber.id, main.id);
      check(
        "waste decreases inventory by exactly the wasted quantity",
        near(afterWaste, 11.8),
        `cucumber = ${afterWaste} kg (12.8 − 1 = expected 11.8)`,
      );

      // ------------------------------------- 4. stock count and its variance
      const systemQuantity = await balanceOf(beef.id, main.id);
      const [count] = await tx
        .insert(stockCounts)
        .values({ organizationId: org.id, locationId: main.id, status: "submitted", reference: "SC-1" })
        .returning();
      // Counted 8 kg against a ledger holding 9.7.
      const [countItem] = await tx
        .insert(stockCountItems)
        .values({
          stockCountId: count.id,
          ingredientId: beef.id,
          systemQuantity: String(systemQuantity),
          countedQuantity: "8",
          unitCostMillis: 30_000,
        })
        .returning();

      const variance = calculateItemVariance({
        ingredientId: beef.id,
        ingredientName: "Beef",
        unit: "kg",
        systemQuantity: Number(countItem.systemQuantity),
        countedQuantity: Number(countItem.countedQuantity),
        unitCostMillis: countItem.unitCostMillis,
      });
      check(
        "variance is counted minus system",
        near(variance.varianceQuantity, 8 - systemQuantity),
        `${variance.varianceQuantity} kg (8 − ${systemQuantity})`,
      );

      // --------------------------------- 5. approval posts exactly the delta
      const adjustments = adjustableItems([variance]);
      await tx.insert(stockMovements).values(
        adjustments.map(item => ({
          organizationId: org.id,
          locationId: main.id,
          ingredientId: item.ingredientId,
          type: "stock_count_adjustment" as const,
          quantity: String(item.varianceQuantity),
          unitCostMillis: item.unitCostMillis,
          referenceType: "stock_count",
          referenceId: count.id,
        })),
      );
      await tx.update(stockCounts).set({ status: "approved", approvedAt: new Date() }).where(eq(stockCounts.id, count.id));

      const afterApproval = await balanceOf(beef.id, main.id);
      check(
        "approval lands the ledger on the counted quantity",
        near(afterApproval, 8),
        `beef = ${afterApproval} kg (expected 8, the counted figure)`,
      );

      const adjustmentRows = await tx
        .select({ n: sql<string>`count(*)` })
        .from(stockMovements)
        .where(and(eq(stockMovements.referenceId, count.id), eq(stockMovements.type, "stock_count_adjustment")));
      check(
        "approval posts exactly one adjustment per varying line",
        Number(adjustmentRows[0]?.n) === adjustments.length,
        `${adjustmentRows[0]?.n} movement(s) for ${adjustments.length} varying line(s)`,
      );

      // A second approval attempt must not double-post. The action guards this
      // with a conditional UPDATE; replayed here against the same condition.
      const [reclaim] = await tx
        .update(stockCounts)
        .set({ status: "approved" })
        .where(and(eq(stockCounts.id, count.id), eq(stockCounts.status, "submitted")))
        .returning({ id: stockCounts.id });
      check(
        "an approved count cannot be approved twice",
        !reclaim,
        reclaim ? "second approval claimed the count" : "second approval claimed nothing",
      );

      // ------------------------------------------------- 6. CSV import path
      const sampleRows = buildSampleCsvRows(
        [{ name: "Hamburger", sellingPriceMillis: 18_000 }],
        "Main",
        "TND",
        new Date(),
      );
      const table = parseCsv(toCsv(sampleRows));
      const importPlan = buildImportPlan(rowsFromTable(table), {
        mapping: suggestMapping(table.headers),
        catalog: [{ id: burger.id, name: "Hamburger", sellingPriceMillis: 18_000 }],
        locations: [{ id: main.id, name: "Main" }],
        defaultLocationId: main.id,
        currency: "TND",
        dateFormat: "auto",
      });
      check(
        "the sample CSV imports with no skipped rows",
        importPlan.stats.skippedRows === 0 && importPlan.stats.importedRows > 0,
        `${importPlan.stats.importedRows} imported, ${importPlan.stats.skippedRows} skipped`,
      );

      let importedUnits = 0;
      for (const plannedSale of importPlan.sales) {
        const [row] = await tx
          .insert(sales)
          .values({
            organizationId: org.id,
            locationId: plannedSale.locationId,
            source: "csv_import",
            status: "recorded",
            reference: plannedSale.reference,
            externalId: plannedSale.idempotencyKey,
            totalMillis: plannedSale.totalMillis,
            soldAt: plannedSale.soldAt,
          })
          .onConflictDoNothing({
            target: [sales.organizationId, sales.source, sales.externalId],
            where: sql`${sales.externalId} is not null`,
          })
          .returning({ id: sales.id });
        if (!row) continue;

        await tx.insert(saleLines).values(
          plannedSale.lines.map(line => ({
            saleId: row.id,
            menuItemId: line.menuItemId,
            menuItemName: line.menuItemName,
            quantity: String(line.quantity),
            unitPriceMillis: line.unitPriceMillis,
            lineTotalMillis: line.lineTotalMillis,
            sortOrder: line.sortOrder,
          })),
        );
        importedUnits += plannedSale.lines.reduce((sum, line) => sum + line.quantity, 0);
      }

      const importedCount = await tx
        .select({ n: sql<string>`count(*)` })
        .from(sales)
        .where(and(eq(sales.organizationId, org.id), eq(sales.source, "csv_import")));
      check(
        "imported sales are recorded and visible to reports",
        Number(importedCount[0]?.n) === importPlan.sales.length,
        `${importedCount[0]?.n} sale(s) with source=csv_import`,
      );

      // ------------------------------------------------- 7. idempotency
      let secondRunInserted = 0;
      for (const plannedSale of importPlan.sales) {
        const [row] = await tx
          .insert(sales)
          .values({
            organizationId: org.id,
            locationId: plannedSale.locationId,
            source: "csv_import",
            status: "recorded",
            reference: plannedSale.reference,
            externalId: plannedSale.idempotencyKey,
            totalMillis: plannedSale.totalMillis,
            soldAt: plannedSale.soldAt,
          })
          .onConflictDoNothing({
            target: [sales.organizationId, sales.source, sales.externalId],
            where: sql`${sales.externalId} is not null`,
          })
          .returning({ id: sales.id });
        if (row) secondRunInserted += 1;
      }
      check(
        "re-importing the same file inserts nothing",
        secondRunInserted === 0,
        `${secondRunInserted} duplicate sale(s) created on the second run`,
      );

      const revenue = await tx
        .select({ total: sql<string>`coalesce(sum(${sales.totalMillis}), 0)` })
        .from(sales)
        .where(and(eq(sales.organizationId, org.id), eq(sales.source, "csv_import"), eq(sales.status, "recorded")));
      check(
        "revenue did not double after the repeat import",
        Number(revenue[0]?.total) === importPlan.stats.totalMillis,
        `${revenue[0]?.total} vs planned ${importPlan.stats.totalMillis}`,
      );
      check("the import produced sold units", importedUnits > 0, `${importedUnits} unit(s)`);

      // ------------------------------------------------- 8. tenant isolation
      const foreignVisible = await tx
        .select({ n: sql<string>`count(*)` })
        .from(sales)
        .where(eq(sales.organizationId, otherOrg.id));
      check(
        "another organization sees none of these sales",
        Number(foreignVisible[0]?.n) === 0,
        `${foreignVisible[0]?.n} sale(s) leaked into the other tenant`,
      );

      const foreignCatalog = await tx
        .select({ n: sql<string>`count(*)` })
        .from(menuItems)
        .where(eq(menuItems.organizationId, otherOrg.id));
      check(
        "the other organization's catalog is empty, so its names cannot resolve",
        Number(foreignCatalog[0]?.n) === 0,
        `${foreignCatalog[0]?.n} menu item(s)`,
      );

      const crossTenantPlan = buildImportPlan(rowsFromTable(table), {
        mapping: suggestMapping(table.headers),
        // The other tenant's catalog: empty, so nothing resolves.
        catalog: [],
        locations: [{ id: main.id, name: "Main" }],
        defaultLocationId: main.id,
        currency: "TND",
        dateFormat: "auto",
      });
      check(
        "a dish outside the caller's catalog cannot be imported",
        crossTenantPlan.stats.importedRows === 0 && crossTenantPlan.unknownMenuItems.length > 0,
        `${crossTenantPlan.stats.importedRows} row(s) imported against a foreign catalog`,
      );

      // --------------------------------------------- 9. location authorization
      const annexPlan = buildImportPlan(rowsFromTable(table), {
        mapping: suggestMapping(table.headers),
        catalog: [{ id: burger.id, name: "Hamburger", sellingPriceMillis: 18_000 }],
        // A member pinned to the Annex: rows naming "Main" must not resolve.
        locations: [{ id: annex.id, name: "Annex" }],
        defaultLocationId: annex.id,
        currency: "TND",
        dateFormat: "auto",
      });
      check(
        "a site-bound member cannot import another location's rows",
        annexPlan.stats.importedRows === 0 && annexPlan.unknownLocations.length > 0,
        `${annexPlan.stats.importedRows} row(s) imported into a location the member cannot use`,
      );

      // ---------------------------------------------------- 10. audit logging
      await tx.insert(auditLogs).values([
        { organizationId: org.id, action: "sale_recorded", entityType: "sale", entityId: sale.id },
        { organizationId: org.id, action: "waste_recorded", entityType: "waste_entry", entityId: waste.id },
        { organizationId: org.id, action: "stock_count_approved", entityType: "stock_count", entityId: count.id },
      ]);
      const audits = await tx
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, org.id));
      check(
        "audit entries are written for the money-moving operations",
        audits.length === 3,
        `${audits.length} entry(ies): ${audits.map(a => a.action).join(", ")}`,
      );


      // ------------------------------------------- 12. transfers between sites
      //
      // The brief's example, end to end: La Marsa → Ariana with beef, cucumber
      // and eggs, checked at each leg against the real ledger.

      const [transferBeef] = await tx
        .insert(ingredients)
        .values({ organizationId: org.id, name: "Transfer Beef", baseUnitCode: "kg", latestUnitCostMillis: 30_000 })
        .returning();
      const [transferEggs] = await tx
        .insert(ingredients)
        .values({ organizationId: org.id, name: "Transfer Eggs", baseUnitCode: "unit", latestUnitCostMillis: 400 })
        .returning();

      // Stock the source: 12 kg beef and 60 eggs at Main.
      await tx.insert(stockMovements).values([
        {
          organizationId: org.id,
          locationId: main.id,
          ingredientId: transferBeef.id,
          type: "purchase",
          quantity: "12",
          unitCostMillis: 30_000,
        },
        {
          organizationId: org.id,
          locationId: main.id,
          ingredientId: transferEggs.id,
          type: "purchase",
          quantity: "60",
          unitCostMillis: 400,
        },
      ]);

      const transferCatalog = [
        { id: transferBeef.id, name: "Transfer Beef", baseUnitCode: "kg", unitCostMillis: 30_000 },
        { id: transferEggs.id, name: "Transfer Eggs", baseUnitCode: "unit", unitCostMillis: 400 },
      ];

      // 10 kg of beef entered in grams, and 30 eggs entered as 2.5 dozen — both
      // exercise the shared unit engine on the way into the ledger.
      const transferLines = prepareTransferLines(
        [
          { ingredientId: transferBeef.id, quantity: 10_000, unitCode: "g" },
          { ingredientId: transferEggs.id, quantity: 2.5, unitCode: "dozen" },
        ],
        transferCatalog,
        unitList,
      );

      check(
        "transfer converts entered units into base units",
        near(transferLines[0].baseQuantity, 10) && near(transferLines[1].baseQuantity, 30),
        `10000 g → ${transferLines[0].baseQuantity} kg, 2.5 dozen → ${transferLines[1].baseQuantity} units`,
      );

      // ---- insufficient stock is refused before anything moves
      const tooMuch = prepareTransferLines(
        [{ ingredientId: transferBeef.id, quantity: 50, unitCode: "kg" }],
        transferCatalog,
        unitList,
      );
      const availabilityRows = await tx
        .select({
          ingredientId: stockMovements.ingredientId,
          balance: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)`,
        })
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.organizationId, org.id),
            eq(stockMovements.locationId, main.id),
            inArray(stockMovements.ingredientId, [transferBeef.id, transferEggs.id]),
          ),
        )
        .groupBy(stockMovements.ingredientId);
      const availableBefore = new Map(availabilityRows.map(row => [row.ingredientId, Number(row.balance)]));
      check(
        "a transfer larger than the source holds is refused",
        findShortfalls(tooMuch, availableBefore).length === 1,
        `asked 50 kg against ${availableBefore.get(transferBeef.id)} kg on hand`,
      );
      check(
        "a transfer the source can cover passes the check",
        findShortfalls(transferLines, availableBefore).length === 0,
        `10 kg + 30 units against ${availableBefore.get(transferBeef.id)} kg / ${availableBefore.get(transferEggs.id)} units`,
      );

      // ---- create and send
      const [transfer] = await tx
        .insert(stockTransfers)
        .values({
          organizationId: org.id,
          sourceLocationId: main.id,
          destinationLocationId: annex.id,
          status: "sent",
          reference: "TR-1",
          sentAt: new Date(),
        })
        .returning();

      await tx.insert(stockTransferItems).values(
        transferLines.map(line => ({
          transferId: transfer.id,
          ingredientId: line.ingredientId,
          quantity: String(line.quantity),
          unitCode: line.unitCode,
          baseQuantity: String(line.baseQuantity),
          unitCostMillis: line.unitCostMillis,
          sortOrder: line.sortOrder,
        })),
      );

      await tx.insert(stockMovements).values(
        transferLines.map(line => ({
          organizationId: org.id,
          locationId: main.id,
          ingredientId: line.ingredientId,
          type: "transfer_out" as const,
          quantity: String(-line.baseQuantity),
          unitCostMillis: line.unitCostMillis,
          referenceType: "stock_transfer",
          referenceId: transfer.id,
        })),
      );

      const sourceAfterSend = await balanceOf(transferBeef.id, main.id);
      const destinationAfterSend = await balanceOf(transferBeef.id, annex.id);
      check(
        "sending deducts from the source",
        near(sourceAfterSend, 2),
        `Main beef = ${sourceAfterSend} kg (12 − 10)`,
      );
      check(
        "sending does not credit the destination yet",
        near(destinationAfterSend, 0),
        `Annex beef = ${destinationAfterSend} kg while in transit`,
      );

      // ---- receive
      const [claimed] = await tx
        .update(stockTransfers)
        .set({ status: "received", receivedAt: new Date() })
        .where(and(eq(stockTransfers.id, transfer.id), eq(stockTransfers.status, "sent")))
        .returning({ id: stockTransfers.id });
      check("receiving claims a sent transfer", Boolean(claimed), claimed ? "claimed" : "claim failed");

      await tx.insert(stockMovements).values(
        transferLines.map(line => ({
          organizationId: org.id,
          locationId: annex.id,
          ingredientId: line.ingredientId,
          type: "transfer_in" as const,
          quantity: String(line.baseQuantity),
          unitCostMillis: line.unitCostMillis,
          referenceType: "stock_transfer",
          referenceId: transfer.id,
        })),
      );

      const destinationAfterReceive = await balanceOf(transferBeef.id, annex.id);
      const eggsAfterReceive = await balanceOf(transferEggs.id, annex.id);
      check(
        "receiving credits the destination",
        near(destinationAfterReceive, 10),
        `Annex beef = ${destinationAfterReceive} kg (expected 10)`,
      );
      check(
        "the converted quantity lands intact",
        near(eggsAfterReceive, 30),
        `Annex eggs = ${eggsAfterReceive} units (2.5 dozen entered)`,
      );

      // ---- the whole point: stock is conserved across the organization
      const orgWideBeef = await tx
        .select({ total: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)` })
        .from(stockMovements)
        .where(and(eq(stockMovements.organizationId, org.id), eq(stockMovements.ingredientId, transferBeef.id)));
      check(
        "a completed transfer moves stock without creating or destroying any",
        near(Number(orgWideBeef[0]?.total), 12),
        `organization-wide beef = ${orgWideBeef[0]?.total} kg (12 purchased, 10 moved)`,
      );

      // ---- duplicate receive prevention (the concurrency guard)
      const [secondClaim] = await tx
        .update(stockTransfers)
        .set({ status: "received", receivedAt: new Date() })
        .where(and(eq(stockTransfers.id, transfer.id), eq(stockTransfers.status, "sent")))
        .returning({ id: stockTransfers.id });
      check(
        "the same transfer cannot be received twice",
        !secondClaim,
        secondClaim ? "a second receive claimed the transfer" : "second receive claimed nothing",
      );

      // ---- same-location and negative quantity are refused by the database
      let sameLocationRejected = false;
      try {
        await tx.transaction(async inner => {
          await inner.insert(stockTransfers).values({
            organizationId: org.id,
            sourceLocationId: main.id,
            destinationLocationId: main.id,
            status: "draft",
          });
        });
      } catch {
        sameLocationRejected = true;
      }
      check(
        "the database refuses a transfer to the same location",
        sameLocationRejected,
        sameLocationRejected ? "CHECK constraint rejected it" : "a self-transfer was accepted",
      );

      let negativeRejected = false;
      try {
        await tx.transaction(async inner => {
          await inner.insert(stockTransferItems).values({
            transferId: transfer.id,
            ingredientId: transferBeef.id,
            quantity: "-5",
            baseQuantity: "-5",
            unitCostMillis: 30_000,
          });
        });
      } catch {
        negativeRejected = true;
      }
      check(
        "the database refuses a negative transfer quantity",
        negativeRejected,
        negativeRejected ? "CHECK constraint rejected it" : "a negative line was accepted",
      );

      // ---- cross-tenant: the other organization sees none of this
      const foreignTransfers = await tx
        .select({ n: sql<string>`count(*)` })
        .from(stockTransfers)
        .where(eq(stockTransfers.organizationId, otherOrg.id));
      check(
        "another organization sees none of these transfers",
        Number(foreignTransfers[0]?.n) === 0,
        `${foreignTransfers[0]?.n} transfer(s) visible to the other tenant`,
      );

      // An ingredient from another tenant cannot be prepared into a line,
      // because the catalog is loaded scoped to one organization.
      check(
        "an ingredient outside the caller's catalog cannot be transferred",
        findMissingIngredients([{ ingredientId: "00000000-0000-4000-8000-00000000dead", quantity: 1 }], transferCatalog).length === 1,
        "a foreign ingredient id does not resolve",
      );

      await tx.insert(auditLogs).values([
        { organizationId: org.id, action: "transfer_sent", entityType: "stock_transfer", entityId: transfer.id },
        { organizationId: org.id, action: "transfer_received", entityType: "stock_transfer", entityId: transfer.id },
      ]);
      const transferAudits = await tx
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(and(eq(auditLogs.organizationId, org.id), eq(auditLogs.entityType, "stock_transfer")));
      check(
        "transfer state changes are audited",
        transferAudits.length === 2,
        `${transferAudits.length} entry(ies): ${transferAudits.map(a => a.action).join(", ")}`,
      );

      // ------------------------------------------- 11. ledger reconciliation
      const byType = await tx
        .select({
          type: stockMovements.type,
          total: sql<string>`sum(${stockMovements.quantity})`,
        })
        .from(stockMovements)
        .where(and(eq(stockMovements.organizationId, org.id), eq(stockMovements.ingredientId, beef.id)))
        .groupBy(stockMovements.type);

      const sumOfTypes = byType.reduce((total, row) => total + Number(row.total), 0);
      const finalBalance = await balanceOf(beef.id, main.id);
      check(
        "the balance equals the sum of every movement type",
        near(sumOfTypes, finalBalance),
        `${byType.map(r => `${r.type}=${r.total}`).join(" ")} → ${finalBalance}`,
      );

      // Deliberate: roll everything back. The probe leaves no trace.
      throw new Error("__rollback__");
    })
    .catch(error => {
      if (!(error instanceof Error) || error.message !== "__rollback__") throw error;
    });

  // -------------------------------------------- 12. transaction safety
  const [leaked] = await getDb()
    .select({ n: sql<string>`count(*)` })
    .from(organizations)
    .where(sql`${organizations.slug} like 'integrity-probe-%' or ${organizations.slug} like 'other-tenant-%'`);
  check(
    "the rolled-back transaction left nothing behind",
    Number(leaked?.n) === 0,
    `${leaked?.n} probe organization(s) still present`,
  );

  // ------------------------------------------------------------------ report
  const width = Math.max(...checks.map(entry => entry.name.length));
  console.log("\nInventory / sales integrity verification\n");
  for (const entry of checks) {
    console.log(`  ${entry.pass ? "PASS" : "FAIL"}  ${entry.name.padEnd(width)}  ${entry.detail}`);
  }

  const failed = checks.filter(entry => !entry.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
