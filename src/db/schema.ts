import { relations, sql } from "drizzle-orm";
import { bigint, boolean, index, integer, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * `viewer` is retired at the application layer — see `MEMBER_ROLES` in
 * `server/tenant`. The label stays because Postgres cannot drop a value from an
 * enum type; nothing reads or writes it, and `normalizeRole` translates any
 * legacy row to `accountant`.
 */
export const memberRole = pgEnum("member_role", ["owner", "manager", "inventory", "kitchen", "accountant", "viewer"]);
export const invitationStatus = pgEnum("invitation_status", ["pending", "accepted", "revoked"]);

/**
 * Stock count lifecycle. `draft` and `counting` are both editable; the split
 * exists so a sheet that has been started reads differently from one nobody has
 * touched. `approved` and `rejected` are terminal — neither can be edited.
 */
export const stockCountStatus = pgEnum("stock_count_status", ["draft", "counting", "submitted", "approved", "rejected"]);
export const movementType = pgEnum("movement_type", ["purchase", "sale_consumption", "waste", "transfer_in", "transfer_out", "stock_count_adjustment", "return_to_supplier", "manual_adjustment"]);
export const wasteReason = pgEnum("waste_reason", ["expired", "damaged", "overproduction", "preparation_error", "quality_issue", "other"]);
export const purchaseStatus = pgEnum("purchase_status", ["draft", "received", "cancelled"]);

/**
 * Where a sale came from. Manual entry today; CSV and POS imports next, using
 * this same pipeline rather than a parallel one.
 */
export const saleSource = pgEnum("sale_source", ["manual", "csv_import", "pos_import"]);

/**
 * A voided sale is kept, never deleted: revenue history that can silently
 * disappear is not history. Voided rows are excluded from every revenue figure.
 */
export const saleStatus = pgEnum("sale_status", ["recorded", "voided"]);

/**
 * How an import run ended. There is no `pending`: the bookkeeping row is written
 * in the same transaction as the sales it describes, so a run that did not
 * commit leaves no row at all.
 */
export const salesImportStatus = pgEnum("sales_import_status", ["completed", "failed"]);

/**
 * Transfer lifecycle: draft → sent → received, with `cancelled` as the escape.
 *
 * Deliberately three live states rather than an approval chain. The physical
 * event has exactly two moments worth recording — the van leaves, the van
 * arrives — and each maps to one leg of the ledger. A separate "approved" state
 * would add a signature without a corresponding stock movement.
 *
 * `cancelled` covers two different situations, distinguished by what the ledger
 * already holds: cancelling a draft writes nothing, while cancelling a sent
 * transfer returns the goods to the source.
 */
export const transferStatus = pgEnum("transfer_status", ["draft", "sent", "received", "cancelled"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  currency: text("currency").notNull().default("TND"),
  locale: text("locale").notNull().default("fr-TN"),
  timezone: text("timezone").notNull().default("Africa/Tunis"),
  /** Set once the owner finishes (or skips) the guided setup checklist. */
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
  ...timestamps,
}, t => [uniqueIndex("organizations_slug_uidx").on(t.slug)]);

export const locations = pgTable("locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address"),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
}, t => [index("locations_org_idx").on(t.organizationId)]);

/**
 * A person's membership of one organization, and the role that authorizes them.
 *
 * Identity is represented by the Supabase Auth user id only. The least-privileged
 * runtime database role cannot read the private auth schema, so server queries
 * must not join membership rows to `auth.users`. Profile data that needs to be
 * shown in the application belongs in a separate application-owned table.
 */
export const organizationMembers = pgTable("organization_members", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  // No default: a membership must always state its role explicitly, so a future
  // insert that forgets one fails loudly instead of silently granting access.
  role: memberRole("role").notNull(),
  defaultLocationId: uuid("default_location_id").references(() => locations.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [primaryKey({ columns: [t.organizationId, t.userId] }), index("org_members_user_idx").on(t.userId)]);

/**
 * A pending offer to join an organization with a predetermined role.
 *
 * Only the SHA-256 hash of the token is stored, so a leaked database yields no
 * usable invitation links. The role lives here rather than on the acceptance
 * request: the invitee proves they hold the link, and the inviter — not the
 * invitee — decides what it grants.
 */
export const organizationInvitations = pgTable("organization_invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  /** Stored lowercased; compared against the accepting user's verified address. */
  email: text("email").notNull(),
  role: memberRole("role").notNull(),
  defaultLocationId: uuid("default_location_id").references(() => locations.id, { onDelete: "set null" }),
  invitedBy: uuid("invited_by"),
  /** SHA-256 of the raw token. The raw value exists only in the shared link. */
  tokenHash: text("token_hash").notNull(),
  status: invitationStatus("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  acceptedBy: uuid("accepted_by"),
  ...timestamps,
}, t => [
  index("org_invitations_org_idx").on(t.organizationId),
  uniqueIndex("org_invitations_token_uidx").on(t.tokenHash),
]);

export const units = pgTable("units", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  name: text("name").notNull(),
  dimension: text("dimension").notNull(),
  multiplierToBase: numeric("multiplier_to_base", { precision: 18, scale: 6 }).notNull().default("1"),
  isBase: boolean("is_base").notNull().default(false),
}, t => [uniqueIndex("units_org_code_uidx").on(t.organizationId, t.code)]);

export const ingredients = pgTable("ingredients", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sku: text("sku"),
  category: text("category"),
  baseUnitCode: text("base_unit_code").notNull(),
  minimumStock: numeric("minimum_stock", { precision: 18, scale: 3 }).notNull().default("0"),
  latestUnitCostMillis: integer("latest_unit_cost_millis").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
}, t => [index("ingredients_org_idx").on(t.organizationId), uniqueIndex("ingredients_org_name_uidx").on(t.organizationId, t.name)]);

export const suppliers = pgTable("suppliers", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  contactName: text("contact_name"),
  phone: text("phone"),
  email: text("email"),
  address: text("address"),
  notes: text("notes"),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
}, t => [index("suppliers_org_idx").on(t.organizationId), uniqueIndex("suppliers_org_name_uidx").on(t.organizationId, t.name)]);

export const supplierProducts = pgTable("supplier_products", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id").notNull().references(() => suppliers.id, { onDelete: "cascade" }),
  ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "cascade" }),
  supplierSku: text("supplier_sku"),
  /** How much of `packUnitCode` a single purchasable package contains. */
  packQuantity: numeric("pack_quantity", { precision: 18, scale: 3 }).notNull().default("1"),
  packUnitCode: text("pack_unit_code"),
  /** Latest observed price for one `packUnitCode`, kept in sync by purchase receiving. */
  lastPriceMillis: integer("last_price_millis").notNull().default(0),
  lastPurchasedAt: timestamp("last_purchased_at", { withTimezone: true }),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
}, t => [
  index("supplier_products_org_idx").on(t.organizationId),
  index("supplier_products_ingredient_idx").on(t.ingredientId),
  uniqueIndex("supplier_products_supplier_ingredient_uidx").on(t.supplierId, t.ingredientId),
]);

export const purchases = pgTable("purchases", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
  invoiceNumber: text("invoice_number"),
  status: purchaseStatus("status").notNull().default("received"),
  totalMillis: integer("total_millis").notNull().default(0),
  notes: text("notes"),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by"),
  clientOperationId: uuid("client_operation_id"),
  ...timestamps,
}, t => [
  index("purchases_org_location_idx").on(t.organizationId, t.locationId),
  index("purchases_org_supplier_idx").on(t.organizationId, t.supplierId),
  uniqueIndex("purchases_client_operation_uidx").on(t.clientOperationId),
]);

export const purchaseItems = pgTable("purchase_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  purchaseId: uuid("purchase_id").notNull().references(() => purchases.id, { onDelete: "cascade" }),
  ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id),
  /** Quantity exactly as it appears on the supplier invoice, expressed in `unitCode`. */
  quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
  unitCode: text("unit_code"),
  unitCostMillis: integer("unit_cost_millis").notNull(),
  lineTotalMillis: integer("line_total_millis").notNull(),
  /** Same line converted into the ingredient base unit; this is what the stock ledger records. */
  baseQuantity: numeric("base_quantity", { precision: 18, scale: 6 }),
  baseUnitCostMillis: integer("base_unit_cost_millis"),
  sortOrder: integer("sort_order").notNull().default(0),
}, t => [index("purchase_items_purchase_idx").on(t.purchaseId), index("purchase_items_ingredient_idx").on(t.ingredientId)]);

export const stockMovements = pgTable("stock_movements", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
  ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "cascade" }),
  type: movementType("type").notNull(),
  quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
  unitCostMillis: integer("unit_cost_millis").notNull().default(0),
  referenceType: text("reference_type"),
  referenceId: uuid("reference_id"),
  note: text("note"),
  performedBy: uuid("performed_by"),
  clientOperationId: uuid("client_operation_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  index("stock_movements_lookup_idx").on(t.organizationId, t.locationId, t.ingredientId),
  index("stock_movements_reference_idx").on(t.referenceType, t.referenceId),
  uniqueIndex("stock_movements_client_operation_uidx").on(t.clientOperationId),
]);

export const wasteEntries = pgTable("waste_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
  ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id),
  quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
  estimatedCostMillis: integer("estimated_cost_millis").notNull().default(0),
  reason: wasteReason("reason").notNull(),
  note: text("note"),
  createdBy: uuid("created_by"),
  clientOperationId: uuid("client_operation_id"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [index("waste_entries_org_location_idx").on(t.organizationId, t.locationId), uniqueIndex("waste_entries_client_operation_uidx").on(t.clientOperationId)]);

/**
 * A recipe is a *preparation*: mayonnaise, stock, dough — something produced in
 * batches and consumed by other preparations or by menu items, never sold
 * directly. The sellable dish is the menu item itself, which owns its own
 * composition in {@link menuItemLines}.
 */
export const recipes = pgTable("recipes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** How much one production batch yields, measured in `yieldUnitCode`. */
  yieldQuantity: numeric("yield_quantity", { precision: 18, scale: 3 }).notNull().default("1"),
  yieldUnitCode: text("yield_unit_code"),
  notes: text("notes"),
  version: integer("version").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
}, t => [index("recipes_org_idx").on(t.organizationId), uniqueIndex("recipes_org_name_uidx").on(t.organizationId, t.name)]);

/**
 * One line of a preparation. Each line targets EITHER a raw ingredient OR
 * another recipe used as a sub-preparation — enforced by a check constraint.
 * Sub-recipe lines are what let a sauce consume stock without flattening it back
 * into bones and water, so a change in an ingredient price still reaches the top.
 */
export const recipeIngredients = pgTable("recipe_ingredients", {
  id: uuid("id").primaryKey().defaultRandom(),
  recipeId: uuid("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  ingredientId: uuid("ingredient_id").references(() => ingredients.id),
  /** Set instead of `ingredientId` when this line consumes another recipe. */
  componentRecipeId: uuid("component_recipe_id").references(() => recipes.id),
  /** Quantity expressed in `unitCode`; converted by the cost engine. */
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  unitCode: text("unit_code"),
  sortOrder: integer("sort_order").notNull().default(0),
}, t => [
  index("recipe_ingredients_recipe_idx").on(t.recipeId),
  index("recipe_ingredients_component_idx").on(t.componentRecipeId),
  uniqueIndex("recipe_ingredients_recipe_ingredient_uidx").on(t.recipeId, t.ingredientId),
  uniqueIndex("recipe_ingredients_recipe_component_uidx").on(t.recipeId, t.componentRecipeId),
]);

/**
 * A sellable dish, with its price. A menu item owns its composition outright
 * through {@link menuItemLines} rather than pointing at a recipe, so editing one
 * dish can never reprice another.
 */
export const menuItems = pgTable("menu_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  /** How many portions the lines below produce. 1 when they describe one serving. */
  yieldQuantity: numeric("yield_quantity", { precision: 18, scale: 3 }).notNull().default("1"),
  sellingPriceMillis: integer("selling_price_millis").notNull(),
  packagingCostMillis: integer("packaging_cost_millis").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
}, t => [index("menu_items_org_idx").on(t.organizationId)]);

/**
 * One line of a dish: a raw ingredient, or a preparation consumed by quantity.
 * Mirrors {@link recipeIngredients}, including the exactly-one-target check
 * constraint. No self-reference guard is needed — a menu item is never itself a
 * component, so this side of the graph cannot form a cycle.
 */
export const menuItemLines = pgTable("menu_item_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  menuItemId: uuid("menu_item_id").notNull().references(() => menuItems.id, { onDelete: "cascade" }),
  ingredientId: uuid("ingredient_id").references(() => ingredients.id),
  /** Set instead of `ingredientId` when this line consumes a preparation. */
  componentRecipeId: uuid("component_recipe_id").references(() => recipes.id),
  /** Quantity expressed in `unitCode`; converted by the cost engine. */
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  unitCode: text("unit_code"),
  sortOrder: integer("sort_order").notNull().default(0),
}, t => [
  index("menu_item_lines_menu_item_idx").on(t.menuItemId),
  index("menu_item_lines_component_idx").on(t.componentRecipeId),
  uniqueIndex("menu_item_lines_item_ingredient_uidx").on(t.menuItemId, t.ingredientId),
  uniqueIndex("menu_item_lines_item_component_uidx").on(t.menuItemId, t.componentRecipeId),
]);

/**
 * One sales transaction: a ticket, a receipt, or a day's aggregate for one
 * location. Lines live in {@link saleLines}.
 *
 * Deliberately *not* a POS. This is the record of what was sold, which is what
 * revenue, food cost and theoretical consumption all need. Order routing, table
 * state and payment capture are a different product.
 *
 * `totalMillis` is a stored rollup of the lines rather than a live sum. Sales
 * are read far more than written — every dashboard and report aggregates them —
 * and unlike stock, a sale is immutable once recorded, so the rollup cannot
 * drift. It is written inside the same transaction as its lines.
 */
export const sales = pgTable("sales", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
  source: saleSource("source").notNull().default("manual"),
  status: saleStatus("status").notNull().default("recorded"),
  /** Ticket or receipt number as humans refer to it. Free-form, not unique. */
  reference: text("reference"),
  /**
   * The id this sale carries in the system it came from. Combined with
   * `source` and the organization it forms the import idempotency key, so
   * re-importing a POS export cannot double-count revenue.
   */
  externalId: text("external_id"),
  totalMillis: integer("total_millis").notNull().default(0),
  note: text("note"),
  /** When the sale happened — not when the row was written. Imports backdate this. */
  soldAt: timestamp("sold_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by"),
  voidedBy: uuid("voided_by"),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidReason: text("void_reason"),
  /** Offline-queue replay guard, matching purchases and waste. */
  clientOperationId: uuid("client_operation_id"),
  /**
   * The import run that created this sale, when one did.
   *
   * Untyped `uuid` rather than a Drizzle `.references()` because `sales_imports`
   * is declared below and a circular reference between the two table objects
   * would not resolve. The foreign key itself is real — migration 0007 adds it
   * with ON DELETE SET NULL, so deleting an import receipt orphans the sales
   * rather than destroying revenue.
   */
  importId: uuid("import_id"),
  ...timestamps,
}, t => [
  index("sales_org_location_sold_idx").on(t.organizationId, t.locationId, t.soldAt),
  index("sales_org_sold_idx").on(t.organizationId, t.soldAt),
  uniqueIndex("sales_client_operation_uidx").on(t.clientOperationId),
  /**
   * Import idempotency. Scoped per source so the same ticket number arriving
   * from a CSV and from a POS are distinct records, and partial per
   * `externalId` so manually entered sales — which have none — are unaffected.
   */
  uniqueIndex("sales_org_source_external_uidx")
    .on(t.organizationId, t.source, t.externalId)
    .where(sql`external_id is not null`),
]);

/**
 * One menu item sold, in one sale.
 *
 * `unitPriceMillis` is a *snapshot*, copied from the menu item when the sale is
 * recorded — never read back from `menu_items` afterwards. Re-pricing a burger
 * from 20 DT to 22 DT must leave last month's revenue untouched, so no query
 * anywhere joins to the current price to value a historical sale.
 *
 * `menuItemId` keeps a real reference for grouping and recipe expansion, while
 * `menuItemName` snapshots the label so a renamed or archived dish still reads
 * correctly on an old receipt.
 */
export const saleLines = pgTable("sale_lines", {
  id: uuid("id").primaryKey().defaultRandom(),
  saleId: uuid("sale_id").notNull().references(() => sales.id, { onDelete: "cascade" }),
  /** Restricted, not cascaded: deleting a dish must not erase the sales that paid for it. */
  menuItemId: uuid("menu_item_id").notNull().references(() => menuItems.id, { onDelete: "restrict" }),
  /** Dish name as it was at the time of sale. */
  menuItemName: text("menu_item_name").notNull(),
  quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
  /** Price for one unit, as sold. The historical-pricing guarantee lives here. */
  unitPriceMillis: integer("unit_price_millis").notNull(),
  /** quantity × unitPriceMillis, stored so revenue never re-derives from a live price. */
  lineTotalMillis: integer("line_total_millis").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
}, t => [
  index("sale_lines_sale_idx").on(t.saleId),
  index("sale_lines_menu_item_idx").on(t.menuItemId),
]);

/**
 * One import run: a CSV upload, or later a sync from a connected POS.
 *
 * A receipt for a bulk write. The sales themselves carry `source` and
 * `external_id`, which is enough to know a row was imported — but not enough to
 * answer the questions that actually get asked after one: which file was this,
 * who ran it, how many rows were rejected and why. Those live here, so the
 * import history screen is a query rather than an archaeology exercise over the
 * audit log.
 *
 * Rows are written in the same transaction as the sales they describe, so a
 * failed import leaves no record claiming success. `status` is therefore only
 * ever `completed` or `failed` — a `pending` state would be unobservable, since
 * an aborted transaction takes its own bookkeeping row down with it.
 *
 * `adapter` names the origin ("csv", later "square", "toast"). Keeping it beside
 * `source` means a future POS integration reuses this table rather than growing
 * a parallel one.
 */
export const salesImports = pgTable("sales_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  /** Location the run defaulted to. Individual sales may differ if the file named others. */
  locationId: uuid("location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
  /** Which pipeline produced this: "csv" today, a vendor key when adapters land. */
  adapter: text("adapter").notNull().default("csv"),
  source: saleSource("source").notNull().default("csv_import"),
  status: salesImportStatus("status").notNull().default("completed"),
  filename: text("filename"),
  /** Bytes of the uploaded file, for the history screen. */
  fileSize: integer("file_size"),
  /** Data rows the file contained, header excluded. */
  totalRows: integer("total_rows").notNull().default(0),
  /** Rows that became sale lines. */
  importedRows: integer("imported_rows").notNull().default(0),
  /** Rows deliberately not imported: validation errors and duplicates. */
  skippedRows: integer("skipped_rows").notNull().default(0),
  /** Rows rejected by validation, a subset of `skippedRows`. */
  failedRows: integer("failed_rows").notNull().default(0),
  /** Rows skipped because the sale was already imported. The rest of `skippedRows`. */
  duplicateRows: integer("duplicate_rows").notNull().default(0),
  /** Sales created — fewer than `importedRows` when lines were grouped into tickets. */
  saleCount: integer("sale_count").notNull().default(0),
  totalMillis: integer("total_millis").notNull().default(0),
  /** Column mapping and options used, as JSON, so a run can be explained or repeated. */
  mapping: text("mapping"),
  /** Per-issue counts as JSON, so the history screen can summarize without the file. */
  issueSummary: text("issue_summary"),
  /** Why the run failed. Null on success. */
  errorMessage: text("error_message"),
  createdBy: uuid("created_by"),
  ...timestamps,
}, t => [
  index("sales_imports_org_idx").on(t.organizationId, t.createdAt),
  index("sales_imports_org_location_idx").on(t.organizationId, t.locationId),
]);

export const salesRelations = relations(sales, ({ one, many }) => ({
  location: one(locations, { fields: [sales.locationId], references: [locations.id] }),
  lines: many(saleLines),
  import: one(salesImports, { fields: [sales.importId], references: [salesImports.id] }),
}));

export const salesImportsRelations = relations(salesImports, ({ one, many }) => ({
  location: one(locations, { fields: [salesImports.locationId], references: [locations.id] }),
  sales: many(sales),
}));

export const saleLinesRelations = relations(saleLines, ({ one }) => ({
  sale: one(sales, { fields: [saleLines.saleId], references: [sales.id] }),
  menuItem: one(menuItems, { fields: [saleLines.menuItemId], references: [menuItems.id] }),
}));

/**
 * A physical inventory count: what the shelves actually hold, against what the
 * ledger says they should.
 *
 * A count never edits stock. When approved it emits one
 * `stock_count_adjustment` movement per variance, so the ledger stays the sole
 * source of truth and the count remains a document explaining why the
 * adjustment happened. Approved counts are immutable — a correction is a new
 * count, not an edit to a historical one.
 */
export const stockCounts = pgTable("stock_counts", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  locationId: uuid("location_id").notNull().references(() => locations.id, { onDelete: "cascade" }),
  status: stockCountStatus("status").notNull().default("draft"),
  reference: text("reference"),
  note: text("note"),
  createdBy: uuid("created_by"),
  submittedBy: uuid("submitted_by"),
  approvedBy: uuid("approved_by"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  /** Why a submitted count was sent back. Only set on `rejected`. */
  rejectionReason: text("rejection_reason"),
  ...timestamps,
}, t => [
  index("stock_counts_org_location_idx").on(t.organizationId, t.locationId),
  index("stock_counts_status_idx").on(t.organizationId, t.status),
]);

/**
 * One ingredient on a count sheet.
 *
 * `systemQuantity` is a snapshot taken when the line is created, not a live
 * read. That is deliberate: the variance describes a moment on the shelf, and
 * the adjustment applied at approval is the *delta* (counted − system), never
 * an overwrite. So if a delivery lands between counting and approval, the
 * delta still lands correctly on top of it instead of erasing it.
 *
 * `countedQuantity` stays null until somebody enters a number — null means
 * "not yet counted", which is not the same as counted zero.
 */
export const stockCountItems = pgTable("stock_count_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  stockCountId: uuid("stock_count_id").notNull().references(() => stockCounts.id, { onDelete: "cascade" }),
  ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id),
  /** Ledger balance in the ingredient base unit, snapshotted when the line was added. */
  systemQuantity: numeric("system_quantity", { precision: 18, scale: 4 }).notNull(),
  /** Physical count, converted into the base unit. Null until entered. */
  countedQuantity: numeric("counted_quantity", { precision: 18, scale: 4 }),
  /** Unit the counter typed in, kept for the audit trail. */
  countedUnitCode: text("counted_unit_code"),
  /** Ingredient cost per base unit at snapshot time, so the value cannot drift later. */
  unitCostMillis: integer("unit_cost_millis").notNull().default(0),
  note: text("note"),
  sortOrder: integer("sort_order").notNull().default(0),
}, t => [
  index("stock_count_items_count_idx").on(t.stockCountId),
  uniqueIndex("stock_count_items_count_ingredient_uidx").on(t.stockCountId, t.ingredientId),
]);

export const stockCountsRelations = relations(stockCounts, ({ one, many }) => ({
  location: one(locations, { fields: [stockCounts.locationId], references: [locations.id] }),
  items: many(stockCountItems),
}));

export const stockCountItemsRelations = relations(stockCountItems, ({ one }) => ({
  count: one(stockCounts, { fields: [stockCountItems.stockCountId], references: [stockCounts.id] }),
  ingredient: one(ingredients, { fields: [stockCountItems.ingredientId], references: [ingredients.id] }),
}));

/**
 * Moving stock between two locations of the same organization.
 *
 * A transfer is a *document*, not a balance: it explains why stock left one
 * kitchen and arrived at another, while `stock_movements` remains the only thing
 * that decides what is on hand. That is the same split stock counts use — the
 * count is the paperwork, the adjustment movement is the effect.
 *
 * ## Two legs, posted at different times
 *
 * Sending writes one `transfer_out` per line at the source. Receiving writes one
 * `transfer_in` per line at the destination. Between the two the goods are in
 * transit: deliberately in neither location's balance, because neither shelf
 * physically holds them. A van that never arrives therefore shows up as a
 * transfer stuck in `sent` rather than as stock silently existing in two places.
 *
 * Posting both legs at send time would have been simpler, but it would credit
 * the destination with stock it cannot yet cook with — and the destination's own
 * stock count would then report a shortfall that is really just a late van.
 *
 * `sourceLocationId != destinationLocationId` and the non-negative quantity rule
 * are both restated as CHECK constraints, so no future code path can create a
 * transfer that moves stock to itself or resurrects it from nothing.
 */
export const stockTransfers = pgTable("stock_transfers", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  sourceLocationId: uuid("source_location_id").notNull().references(() => locations.id, { onDelete: "restrict" }),
  destinationLocationId: uuid("destination_location_id").notNull().references(() => locations.id, { onDelete: "restrict" }),
  status: transferStatus("status").notNull().default("draft"),
  /** Human-facing document number, e.g. "TR-1042". Free-form, not unique. */
  reference: text("reference"),
  note: text("note"),
  createdBy: uuid("created_by"),
  /** Who dispatched it — the person accountable for the stock leaving. */
  sentBy: uuid("sent_by"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** Who confirmed arrival at the destination. */
  receivedBy: uuid("received_by"),
  receivedAt: timestamp("received_at", { withTimezone: true }),
  cancelledBy: uuid("cancelled_by"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancelReason: text("cancel_reason"),
  ...timestamps,
}, t => [
  index("stock_transfers_org_idx").on(t.organizationId, t.createdAt),
  // The list screen splits into outgoing and incoming, so each direction gets
  // the index its filter needs.
  index("stock_transfers_source_idx").on(t.organizationId, t.sourceLocationId, t.status),
  index("stock_transfers_destination_idx").on(t.organizationId, t.destinationLocationId, t.status),
]);

/**
 * One ingredient on a transfer.
 *
 * `quantity` is what the user typed, in `unitCode` — 30 units of eggs, or 2
 * dozen. `baseQuantity` is the same amount converted into the ingredient's base
 * unit, and it is the only figure the ledger ever sees. Both are stored for the
 * same reason purchases store both: the document should read back the way it was
 * written, while the ledger stays in one canonical unit.
 *
 * `unitCostMillis` is snapshotted when the transfer is sent, so the value moved
 * between sites is the value at dispatch and cannot drift with later purchases.
 */
export const stockTransferItems = pgTable("stock_transfer_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  transferId: uuid("transfer_id").notNull().references(() => stockTransfers.id, { onDelete: "cascade" }),
  /** Restricted, not cascaded: deleting an ingredient must not erase transfer history. */
  ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id, { onDelete: "restrict" }),
  /** Quantity as entered, expressed in `unitCode`. */
  quantity: numeric("quantity", { precision: 18, scale: 3 }).notNull(),
  unitCode: text("unit_code"),
  /** The same quantity in the ingredient's base unit. This is what the ledger records. */
  baseQuantity: numeric("base_quantity", { precision: 18, scale: 6 }).notNull(),
  /** Cost per base unit at dispatch, so the transferred value cannot drift. */
  unitCostMillis: integer("unit_cost_millis").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
}, t => [
  index("stock_transfer_items_transfer_idx").on(t.transferId),
  index("stock_transfer_items_ingredient_idx").on(t.ingredientId),
  // One line per ingredient: two lines for the same ingredient would be two
  // answers to "how much beef is moving", and the second would be invisible on
  // a screen that groups by ingredient.
  uniqueIndex("stock_transfer_items_transfer_ingredient_uidx").on(t.transferId, t.ingredientId),
]);

export const stockTransfersRelations = relations(stockTransfers, ({ one, many }) => ({
  source: one(locations, { fields: [stockTransfers.sourceLocationId], references: [locations.id], relationName: "transferSource" }),
  destination: one(locations, { fields: [stockTransfers.destinationLocationId], references: [locations.id], relationName: "transferDestination" }),
  items: many(stockTransferItems),
}));

export const stockTransferItemsRelations = relations(stockTransferItems, ({ one }) => ({
  transfer: one(stockTransfers, { fields: [stockTransferItems.transferId], references: [stockTransfers.id] }),
  ingredient: one(ingredients, { fields: [stockTransferItems.ingredientId], references: [ingredients.id] }),
}));

export const auditLogs = pgTable("audit_logs", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  organizationId: uuid("organization_id").notNull(),
  userId: uuid("user_id"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [index("audit_logs_org_idx").on(t.organizationId)]);

export const organizationsRelations = relations(organizations, ({ many }) => ({ locations: many(locations), members: many(organizationMembers), ingredients: many(ingredients) }));
export const ingredientsRelations = relations(ingredients, ({ one, many }) => ({ organization: one(organizations, { fields: [ingredients.organizationId], references: [organizations.id] }), movements: many(stockMovements), supplierProducts: many(supplierProducts) }));
export const suppliersRelations = relations(suppliers, ({ one, many }) => ({ organization: one(organizations, { fields: [suppliers.organizationId], references: [organizations.id] }), products: many(supplierProducts) }));
export const supplierProductsRelations = relations(supplierProducts, ({ one }) => ({ supplier: one(suppliers, { fields: [supplierProducts.supplierId], references: [suppliers.id] }), ingredient: one(ingredients, { fields: [supplierProducts.ingredientId], references: [ingredients.id] }) }));
export const purchasesRelations = relations(purchases, ({ one, many }) => ({ supplier: one(suppliers, { fields: [purchases.supplierId], references: [suppliers.id] }), location: one(locations, { fields: [purchases.locationId], references: [locations.id] }), items: many(purchaseItems) }));
export const purchaseItemsRelations = relations(purchaseItems, ({ one }) => ({ purchase: one(purchases, { fields: [purchaseItems.purchaseId], references: [purchases.id] }), ingredient: one(ingredients, { fields: [purchaseItems.ingredientId], references: [ingredients.id] }) }));
export const recipesRelations = relations(recipes, ({ many }) => ({ lines: many(recipeIngredients) }));
export const recipeIngredientsRelations = relations(recipeIngredients, ({ one }) => ({ recipe: one(recipes, { fields: [recipeIngredients.recipeId], references: [recipes.id] }), ingredient: one(ingredients, { fields: [recipeIngredients.ingredientId], references: [ingredients.id] }) }));
export const menuItemsRelations = relations(menuItems, ({ many }) => ({ lines: many(menuItemLines) }));
export const menuItemLinesRelations = relations(menuItemLines, ({ one }) => ({ menuItem: one(menuItems, { fields: [menuItemLines.menuItemId], references: [menuItems.id] }), ingredient: one(ingredients, { fields: [menuItemLines.ingredientId], references: [ingredients.id] }), component: one(recipes, { fields: [menuItemLines.componentRecipeId], references: [recipes.id] }) }));

export const inventoryBalanceSql = sql`coalesce(sum(${stockMovements.quantity}), 0)`;
