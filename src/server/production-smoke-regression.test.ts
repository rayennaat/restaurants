import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

const WASTE_PAGE = read("src/app/dashboard/waste/page.tsx");
const LOCATION_SELECTION = read("src/lib/location-selection.ts");
const WASTE_FORM = read("src/components/forms/waste-form.tsx");
const WASTE_API = read("src/app/api/waste/route.ts");
const SALES_ACTIONS = read("src/server/actions/sales.ts");
const SALES_IMPORT_ACTIONS = read("src/server/actions/sales-import.ts");
const SALE_CONSUMPTION = read("src/server/sale-consumption.ts");
const SUPPLIER_QUERIES = read("src/server/queries/suppliers.ts");
const SUPPLIER_DETAIL = read("src/app/dashboard/suppliers/[id]/page.tsx");
const ANALYTICS = read("src/server/queries/analytics.ts");
const DASHBOARD = read("src/app/dashboard/page.tsx");

function code(source: string) {
  return source;
}

describe("multi-location waste regression", () => {
  it("renders an explicit location selector instead of a hidden tenant default", () => {
    expect(WASTE_PAGE).toContain("resolveMemberLocation");
    expect(WASTE_PAGE).toContain("defaultLocationId={selectedLocationId}");
    expect(WASTE_PAGE).toContain('defaultLocationId(location.id, location.options)');
    expect(LOCATION_SELECTION).toContain('permittedLocations.length === 1');
    expect(LOCATION_SELECTION).toContain(': ""');
    expect(WASTE_FORM).toContain('Field label="Location"');
    expect(WASTE_FORM).toContain('register("locationId")');
    expect(WASTE_FORM).not.toContain('type="hidden" {...register("locationId")}');
  });

  it("authorizes the submitted waste location before writing ledger rows", () => {
    const source = code(WASTE_API);
    expect(source).toContain("const locationId = input.locationId");
    expect(source).toContain('return NextResponse.json({ error: "Choose a location for this waste entry." }');
    expect(source).toContain('await assertMemberLocation(tenant, locationId, "record waste")');
    expect(source).toContain(".insert(wasteEntries)");
    expect(source).toContain("locationId,");
    expect(source).toContain(".insert(stockMovements)");
    expect(source).not.toContain("locationId: tenant.locationId!");
  });
});

describe("negative stock sale regression", () => {
  it("checks theoretical consumption against location stock inside manual sale transaction", () => {
    const source = code(SALES_ACTIONS);
    const transaction = source.slice(source.indexOf("const saleId = await db.transaction"));
    expect(transaction.indexOf("assertSaleStockAvailable")).toBeGreaterThanOrEqual(0);
    expect(transaction.indexOf("assertSaleStockAvailable")).toBeLessThan(transaction.indexOf("insert(sales)"));
    expect(transaction).toContain("postSaleConsumption(tx, {");
  });

  it("uses the same stock availability guard for CSV imports", () => {
    const source = code(SALES_IMPORT_ACTIONS);
    expect(source).toContain("const soldLines = sale.lines.map");
    expect(source).toContain("await assertSaleStockAvailable(tx");
    expect(source).toContain("soldLines,");
  });

  it("serializes concurrent sale checks and reports required versus available quantities", () => {
    const source = code(SALE_CONSUMPTION);
    const guard = source.slice(source.indexOf("export async function assertSaleStockAvailable"));
    expect(guard).toContain("planSaleConsumption(input.soldLines, input.requirements)");
    expect(guard).toContain("pg_advisory_xact_lock");
    expect(guard).toContain("eq(stockMovements.locationId, input.locationId)");
    expect(guard).toContain("coalesce(sum(${stockMovements.quantity}), 0)");
    expect(guard).toContain("throw new ActionError(shortageMessage(shortages))");
    expect(source).toContain("required ${formatStockQuantity(row.required)}");
    expect(source).toContain("available ${formatStockQuantity(row.available)}");
  });
});

describe("supplier metric consistency regression", () => {
  it("derives supplier list and detail metrics from the same catalog and invoice sources", () => {
    const source = code(SUPPLIER_QUERIES);
    const metrics = source.slice(source.indexOf("export async function getSupplierDetailMetrics"));
    expect(metrics).toContain("supplierProducts");
    expect(metrics).toContain("purchaseItems");
    expect(metrics).toContain("p.status = 'received'");
    expect(metrics).toContain("count(distinct ingredient_id)");
    expect(metrics).toContain("pricePointCount");

    const list = source.slice(source.indexOf("export async function listSuppliers"), source.indexOf("export async function getSupplier("));
    expect(list).toContain("count(distinct product.ingredient_id)");
    expect(list).toContain("purchaseItems");
    expect(list).toContain("pricePointCount");
    expect(list).toContain("p.status = 'received'");
  });

  it("shows those metrics on the supplier detail and list cards", () => {
    expect(SUPPLIER_DETAIL).toContain("getSupplierDetailMetrics");
    expect(SUPPLIER_DETAIL).toContain("metrics.productCount");
    expect(SUPPLIER_DETAIL).toContain("metrics.pricePointCount");

    const listPage = read("src/app/dashboard/suppliers/page.tsx");
    expect(listPage).toContain("row.pricePointCount");
    expect(listPage).not.toContain("{comparison.length}</p>");
  });
});

describe("all-locations stock-health regression", () => {
  it("computes location-level stock alerts separately from aggregate valuation", () => {
    const source = code(ANALYTICS);
    const alerts = source.slice(
      source.indexOf("export async function getLocationStockAlerts"),
      source.indexOf("export type CategoryValueRow"),
    );
    expect(alerts).toContain("join ${ingredients} i on i.organization_id = l.organization_id");
    expect(alerts).toContain("sm.location_id = l.id");
    expect(alerts).toContain("stock <= 0 or (minimum > 0 and stock > 0 and stock <= minimum)");
    expect(alerts).toContain("locationName");
    expect(alerts).not.toContain("limit ${limit}");
  });

  it("surfaces location alerts on the all-locations dashboard", () => {
    expect(DASHBOARD).toContain("getLocationStockAlerts");
    expect(DASHBOARD).toContain("scope.locationId ? Promise.resolve([]) : getLocationStockAlerts");
    expect(DASHBOARD).toContain("locationAttentionCount");
    expect(DASHBOARD).toContain("Location stock alerts");
    expect(DASHBOARD).toContain("summarizeLocationStockAlerts");
    expect(DASHBOARD).toContain("affectedLocationNames");
    expect(DASHBOARD).toContain("Combined stock hides branch shortages");
  });
});
