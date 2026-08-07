import { relations, sql } from "drizzle-orm";
import { bigint, boolean, index, integer, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const memberRole = pgEnum("member_role", ["owner", "manager", "inventory", "kitchen", "accountant", "viewer"]);
export const movementType = pgEnum("movement_type", ["purchase", "sale_consumption", "waste", "transfer_in", "transfer_out", "stock_count_adjustment", "return_to_supplier", "manual_adjustment"]);
export const wasteReason = pgEnum("waste_reason", ["expired", "damaged", "overproduction", "preparation_error", "quality_issue", "other"]);
export const purchaseStatus = pgEnum("purchase_status", ["draft", "received", "cancelled"]);

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

export const organizationMembers = pgTable("organization_members", {
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull(),
  role: memberRole("role").notNull().default("viewer"),
  defaultLocationId: uuid("default_location_id").references(() => locations.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [primaryKey({ columns: [t.organizationId, t.userId] }), index("org_members_user_idx").on(t.userId)]);

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

export const recipes = pgTable("recipes", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** Number of servings/portions one production batch of this recipe yields. */
  yieldQuantity: numeric("yield_quantity", { precision: 18, scale: 3 }).notNull().default("1"),
  yieldUnitCode: text("yield_unit_code"),
  notes: text("notes"),
  version: integer("version").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
}, t => [index("recipes_org_idx").on(t.organizationId), uniqueIndex("recipes_org_name_uidx").on(t.organizationId, t.name)]);

export const recipeIngredients = pgTable("recipe_ingredients", {
  recipeId: uuid("recipe_id").notNull().references(() => recipes.id, { onDelete: "cascade" }),
  ingredientId: uuid("ingredient_id").notNull().references(() => ingredients.id),
  /** Quantity expressed in `unitCode`; converted to the ingredient base unit by the cost engine. */
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  unitCode: text("unit_code"),
  sortOrder: integer("sort_order").notNull().default(0),
}, t => [primaryKey({ columns: [t.recipeId, t.ingredientId] })]);

export const menuItems = pgTable("menu_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  recipeId: uuid("recipe_id").references(() => recipes.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  category: text("category"),
  sellingPriceMillis: integer("selling_price_millis").notNull(),
  packagingCostMillis: integer("packaging_cost_millis").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  ...timestamps,
}, t => [index("menu_items_org_idx").on(t.organizationId), index("menu_items_recipe_idx").on(t.recipeId)]);

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
export const recipesRelations = relations(recipes, ({ many }) => ({ lines: many(recipeIngredients), menuItems: many(menuItems) }));
export const recipeIngredientsRelations = relations(recipeIngredients, ({ one }) => ({ recipe: one(recipes, { fields: [recipeIngredients.recipeId], references: [recipes.id] }), ingredient: one(ingredients, { fields: [recipeIngredients.ingredientId], references: [ingredients.id] }) }));
export const menuItemsRelations = relations(menuItems, ({ one }) => ({ recipe: one(recipes, { fields: [menuItems.recipeId], references: [recipes.id] }) }));

export const inventoryBalanceSql = sql`coalesce(sum(${stockMovements.quantity}), 0)`;
