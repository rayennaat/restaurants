import { z } from "zod";
import { SUPPORTED_CURRENCIES } from "./money";
import { UNIT_DIMENSIONS } from "./units";
import { DATE_FORMATS, IMPORT_FIELDS } from "./sales-import";

/**
 * Every mutation in the app validates through this module, on the server as
 * well as in the React Hook Form resolver, so the client and the database can
 * never disagree about what a valid record looks like.
 *
 * Money fields are captured in *major* units (18.500 TND) and converted to the
 * integer minor units the database stores by the server action / route handler.
 */

const uuid = z.string().uuid("Select a valid option");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const optionalUuid = z
  .string()
  .trim()
  .transform(value => (value === "" ? undefined : value))
  .pipe(uuid.optional())
  .optional();
const shortText = (max: number) => z.string().trim().min(1, "Required").max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform(value => (value === "" ? undefined : value))
    .optional();

const majorMoney = z.coerce.number({ message: "Enter an amount" }).nonnegative("Cannot be negative").max(1_000_000_000);
const positiveQuantity = z.coerce.number({ message: "Enter a quantity" }).positive("Must be greater than zero").max(1_000_000_000);
const nonNegativeQuantity = z.coerce.number({ message: "Enter a quantity" }).nonnegative("Cannot be negative").max(1_000_000_000);

export const unitCode = z.string().trim().min(1, "Select a unit").max(24);

// ---------------------------------------------------------------- organization

export const onboardingInput = z.object({
  organizationName: shortText(120),
  locationName: shortText(120),
  currency: z.enum(SUPPORTED_CURRENCIES),
  locale: z.enum(["fr-TN", "ar-TN", "en-US", "fr-FR"]),
  timezone: optionalText(64),
});
export type OnboardingInput = z.infer<typeof onboardingInput>;

export const organizationSettingsInput = z.object({
  name: shortText(120),
  currency: z.enum(SUPPORTED_CURRENCIES),
  locale: z.enum(["fr-TN", "ar-TN", "en-US", "fr-FR"]),
  timezone: shortText(64),
});

export const locationInput = z.object({
  id: optionalUuid,
  name: shortText(120),
  address: optionalText(250),
  isActive: z.coerce.boolean().default(true),
});

export const unitInput = z.object({
  id: optionalUuid,
  code: z
    .string()
    .trim()
    .min(1, "Required")
    .max(24)
    .regex(/^[a-z0-9_-]+$/i, "Letters, numbers, dash and underscore only"),
  name: shortText(60),
  dimension: z.enum(UNIT_DIMENSIONS),
  multiplierToBase: z.coerce.number({ message: "Enter a multiplier" }).positive("Must be greater than zero"),
});
export type UnitInput = z.infer<typeof unitInput>;

// ------------------------------------------------------------------ ingredient

export const ingredientInput = z.object({
  id: optionalUuid,
  name: shortText(120),
  sku: optionalText(60),
  category: optionalText(60),
  baseUnitCode: unitCode,
  minimumStock: nonNegativeQuantity.default(0),
  /** Default/latest cost of one base unit, in major currency units. */
  unitCost: majorMoney.default(0),
  isActive: z.coerce.boolean().default(true),
});
export type IngredientInput = z.infer<typeof ingredientInput>;

export const ingredientFilters = z.object({
  q: z.string().trim().max(120).optional(),
  category: z.string().trim().max(60).optional(),
  unit: z.string().trim().max(24).optional(),
  status: z.enum(["active", "archived", "all"]).default("active"),
  stock: z.enum(["all", "low", "out"]).default("all"),
  sort: z.enum(["name", "cost", "stock", "updated"]).default("name"),
});
export type IngredientFilters = z.infer<typeof ingredientFilters>;

// -------------------------------------------------------------------- supplier

export const supplierInput = z.object({
  id: optionalUuid,
  name: shortText(120),
  contactName: optionalText(120),
  phone: optionalText(40),
  email: z
    .string()
    .trim()
    .max(160)
    .transform(value => (value === "" ? undefined : value))
    .pipe(z.string().email("Enter a valid email").optional())
    .optional(),
  address: optionalText(250),
  notes: optionalText(1000),
  isActive: z.coerce.boolean().default(true),
});
export type SupplierInput = z.infer<typeof supplierInput>;

export const supplierProductInput = z.object({
  id: optionalUuid,
  supplierId: uuid,
  ingredientId: uuid,
  supplierSku: optionalText(60),
  /** How much of `packUnitCode` one purchasable package holds. */
  packQuantity: positiveQuantity.default(1),
  packUnitCode: unitCode,
  /** Latest price for one `packUnitCode`, in major currency units. */
  unitPrice: majorMoney.default(0),
  isActive: z.coerce.boolean().default(true),
});
export type SupplierProductInput = z.infer<typeof supplierProductInput>;

// -------------------------------------------------------------------- purchase

export const purchaseItemInput = z.object({
  ingredientId: uuid,
  quantity: positiveQuantity,
  unitCode: unitCode,
  /** Price of one `unitCode`, in major currency units. */
  unitCost: majorMoney,
});
export type PurchaseItemInput = z.infer<typeof purchaseItemInput>;

export const purchaseInput = z.object({
  supplierId: optionalUuid,
  locationId: uuid,
  invoiceNumber: optionalText(100),
  receivedAt: z
    .string()
    .trim()
    .transform(value => (value === "" ? undefined : value))
    .optional(),
  notes: optionalText(1000),
  items: z.array(purchaseItemInput).min(1, "Add at least one invoice line").max(200),
  clientOperationId: z.string().uuid().optional(),
});
export type PurchaseInput = z.infer<typeof purchaseInput>;

// ---------------------------------------------------------- recipe (preparation)

/**
 * One composition line, shared by preparations and menu items. `kind` selects
 * the target: a raw ingredient, or a preparation consumed by quantity. The
 * unused id is dropped so the DB check constraint (exactly one target) is always
 * satisfied.
 */
export const recipeIngredientInput = z
  .object({
    kind: z.enum(["ingredient", "recipe"]).default("ingredient"),
    ingredientId: z.string().trim().optional(),
    componentRecipeId: z.string().trim().optional(),
    quantity: positiveQuantity,
    unitCode: unitCode,
  })
  .superRefine((line, ctx) => {
    if (line.kind === "recipe") {
      if (!line.componentRecipeId || !UUID_RE.test(line.componentRecipeId)) {
        ctx.addIssue({ code: "custom", path: ["componentRecipeId"], message: "Choose a preparation" });
      }
    } else if (!line.ingredientId || !UUID_RE.test(line.ingredientId)) {
      ctx.addIssue({ code: "custom", path: ["ingredientId"], message: "Choose an ingredient" });
    }
  })
  .transform(line =>
    line.kind === "recipe"
      ? { kind: "recipe" as const, componentRecipeId: line.componentRecipeId!, ingredientId: undefined, quantity: line.quantity, unitCode: line.unitCode }
      : { kind: "ingredient" as const, ingredientId: line.ingredientId!, componentRecipeId: undefined, quantity: line.quantity, unitCode: line.unitCode },
  );

/**
 * A recipe is a preparation: produced in batches and consumed by dishes or by
 * other preparations. Dishes are menu items — see {@link menuItemInput}.
 */
export const recipeInput = z.object({
  id: optionalUuid,
  name: shortText(120),
  /** What one production batch produces, measured in `yieldUnitCode`. */
  yieldQuantity: positiveQuantity.default(1),
  yieldUnitCode: optionalText(24),
  notes: optionalText(2000),
  isActive: z.coerce.boolean().default(true),
  items: z.array(recipeIngredientInput).min(1, "A recipe needs at least one line").max(100).superRefine(rejectDuplicateLines),
});
export type RecipeInput = z.infer<typeof recipeInput>;

// ------------------------------------------------------------- menu item (dish)

/** Reusable duplicate-line guard, shared by preparations and menu items. */
function rejectDuplicateLines(items: z.infer<typeof recipeIngredientInput>[], ctx: z.RefinementCtx) {
  const seenIngredients = new Set<string>();
  const seenRecipes = new Set<string>();
  items.forEach((item, index) => {
    const key = item.kind === "recipe" ? item.componentRecipeId! : item.ingredientId!;
    const seen = item.kind === "recipe" ? seenRecipes : seenIngredients;
    if (seen.has(key)) {
      ctx.addIssue({
        code: "custom",
        path: [index, item.kind === "recipe" ? "componentRecipeId" : "ingredientId"],
        message: item.kind === "recipe" ? "This preparation is already on the list" : "This ingredient is already on the list",
      });
    }
    seen.add(key);
  });
}

/**
 * A menu item is a dish: it owns its own composition and its own price. There is
 * no recipe behind it — the same dish sold at two prices is simply two menu
 * items, each with its own lines.
 */
export const menuItemInput = z.object({
  id: optionalUuid,
  name: shortText(120),
  category: optionalText(60),
  /** How many portions one batch of the lines below yields. */
  yieldQuantity: positiveQuantity.default(1),
  /** Menu price, in major currency units. */
  sellingPrice: majorMoney,
  /** Packaging/consumable cost per sale, in major currency units. */
  packagingCost: majorMoney.default(0),
  isActive: z.coerce.boolean().default(true),
  items: z.array(recipeIngredientInput).min(1, "Add at least one ingredient or preparation").max(100).superRefine(rejectDuplicateLines),
});
export type MenuItemInput = z.infer<typeof menuItemInput>;

// ----------------------------------------------------------------------- waste

export const wasteInput = z.object({
  ingredientId: uuid,
  locationId: optionalUuid,
  quantity: positiveQuantity,
  unitCode: unitCode.optional(),
  reason: z.enum(["expired", "damaged", "overproduction", "preparation_error", "quality_issue", "other"]),
  note: optionalText(500),
  clientOperationId: z.string().uuid().optional(),
});
export type WasteInput = z.infer<typeof wasteInput>;

// ------------------------------------------------------------------- inventory

export const stockAdjustmentInput = z.object({
  ingredientId: uuid,
  locationId: uuid,
  /** Counted physical quantity, in the ingredient base unit. */
  countedQuantity: nonNegativeQuantity,
  note: optionalText(500),
});
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentInput>;

// ------------------------------------------------------------------------ team

/**
 * Roles an invitation may grant.
 *
 * `owner` is absent by construction, not by validation order: ownership is
 * transferred by an explicit promotion that requires `transfer_ownership`. The
 * same rule is enforced by the action layer and by a CHECK constraint on
 * `organization_invitations`, so all three would have to fail together for a
 * link to hand out a workspace.
 */
export const invitableRole = z.enum(["manager", "inventory", "kitchen", "accountant"]);

/** Any active role, used where an owner is legitimately assignable (promotion). */
export const assignableRole = z.enum(["owner", "manager", "inventory", "kitchen", "accountant"]);

const memberEmail = z
  .string()
  .trim()
  .min(1, "Enter an email address")
  .max(254)
  .email("Enter a valid email address")
  // Stored and compared lowercased so "Rayen@x.com" cannot receive a second
  // invitation alongside "rayen@x.com".
  .transform(value => value.toLowerCase());

export const inviteEmployeeInput = z.object({
  email: memberEmail,
  role: invitableRole,
  defaultLocationId: optionalUuid,
});
export type InviteEmployeeInput = z.infer<typeof inviteEmployeeInput>;

export const changeMemberRoleInput = z.object({
  userId: uuid,
  role: assignableRole,
});
export type ChangeMemberRoleInput = z.infer<typeof changeMemberRoleInput>;

export const changeMemberLocationInput = z.object({
  userId: uuid,
  defaultLocationId: optionalUuid,
});
export type ChangeMemberLocationInput = z.infer<typeof changeMemberLocationInput>;

// ---------------------------------------------------------------- stock counts

/** Which ingredients a new count sheet should open with. */
export const countScope = z.enum(["all", "category", "low_stock", "selected"]);

export const createStockCountInput = z.object({
  locationId: uuid,
  reference: optionalText(60),
  note: optionalText(500),
  scope: countScope.default("all"),
  /** Required when scope is "category". */
  category: optionalText(60),
  /** Required when scope is "selected". */
  ingredientIds: z.array(uuid).max(500).optional(),
});
export type CreateStockCountInput = z.infer<typeof createStockCountInput>;

/**
 * One entered line. `countedQuantity` is nullable so clearing a field means
 * "not counted" rather than "counted zero" — the two are different facts and
 * the variance engine treats them differently.
 */
export const stockCountEntryInput = z.object({
  itemId: uuid,
  countedQuantity: z
    .union([z.literal(""), z.null(), z.coerce.number().nonnegative("Cannot be negative").max(1_000_000_000)])
    .optional()
    .transform(value => (typeof value === "number" ? value : null)),
  unitCode: z.string().trim().max(24).optional(),
  note: optionalText(250),
});

export const saveStockCountEntriesInput = z.object({
  stockCountId: uuid,
  entries: z.array(stockCountEntryInput).max(500),
});
export type SaveStockCountEntriesInput = z.infer<typeof saveStockCountEntriesInput>;

export const rejectStockCountInput = z.object({
  stockCountId: uuid,
  // A rejection without a reason gives the counter nothing to act on, and the
  // database enforces the same rule.
  reason: shortText(500),
});
export type RejectStockCountInput = z.infer<typeof rejectStockCountInput>;

// ------------------------------------------------------------------------- sales

/**
 * One line of a sale being recorded.
 *
 * The menu item is identified by id and resolved on the server against the
 * caller's own organization; the displayed name and price are then snapshotted
 * from the menu item into the sale line, so a later rename or re-price cannot
 * rewrite history. Nothing about the price is accepted from the client.
 */
export const saleLineInput = z.object({
  menuItemId: uuid,
  /** How many portions sold. Fractional portions are deliberately allowed — a "half burger" is real. */
  quantity: z.coerce.number({ message: "Enter a quantity" }).positive("Must be greater than zero").max(1_000_000),
});
export type SaleLineInput = z.infer<typeof saleLineInput>;

export const recordSaleInput = z.object({
  locationId: uuid,
  /** Human ticket/receipt label. Optional, not unique. */
  reference: optionalText(60),
  /**
   * Idempotency for imports. Together with `source` this is the key a later
   * CSV/POS import will reuse; recording the same external id twice must not
   * double-count revenue.
   */
  source: z.enum(["manual", "csv_import", "pos_import"]).default("manual"),
  externalId: optionalText(120),
  /** When the sale happened. Manual entries default to now; imports backdate. */
  soldAt: z
    .string()
    .datetime({ offset: true, message: "Enter a valid date and time" })
    .optional()
    .transform(value => (value ? new Date(value) : undefined)),
  note: optionalText(500),
  items: z.array(saleLineInput).min(1, "Add at least one sold item").max(200, "Too many lines for one sale"),
});
export type RecordSaleInput = z.infer<typeof recordSaleInput>;

export const voidSaleInput = z.object({
  saleId: uuid,
  reason: shortText(300),
});
export type VoidSaleInput = z.infer<typeof voidSaleInput>;

// ---------------------------------------------------------------- sales import

/**
 * Column mapping: which source column feeds which field.
 *
 * A record rather than a fixed object because the *keys* are the fixed part
 * (`IMPORT_FIELDS`) while the values are whatever headers the user's own POS
 * produced. `null` is accepted alongside `undefined` so a cleared dropdown
 * round-trips as "not mapped" instead of failing validation.
 */
export const importColumnMapping = z.record(
  z.enum(IMPORT_FIELDS),
  z.string().trim().max(200).nullable().optional(),
);

/** Upload limits. Generous enough for a year of tickets, bounded enough to parse in a request. */
export const IMPORT_MAX_BYTES = 8 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 20_000;

/**
 * Shared shape of a preview and a commit.
 *
 * Both carry the *same* inputs, and the server rebuilds the plan from the file
 * on each call rather than trusting a plan the client sends back. That is the
 * point: a confirmed import re-validates from scratch, so a tampered or stale
 * preview cannot smuggle in a price, a menu item from another workspace, or a
 * row the validator rejected.
 */
const salesImportBase = {
  filename: optionalText(260),
  /** Raw CSV text. Parsed on the server; the client's parse is only for display. */
  content: z.string().min(1, "The file is empty").max(IMPORT_MAX_BYTES, "That file is too large to import"),
  delimiter: z.enum([",", ";", "\t", "|"]).optional(),
  mapping: importColumnMapping,
  locationId: uuid,
  dateFormat: z.enum(DATE_FORMATS).default("auto"),
  /**
   * Currency the file's amounts are written in. Defaults to the workspace
   * currency; stated explicitly because a decimal in a file means nothing until
   * you know whether 18.5 is 18500 millimes or 1850 cents.
   */
  currency: z.enum(SUPPORTED_CURRENCIES).optional(),
  /**
   * User-chosen resolutions for names the catalog does not contain: the CSV's
   * own text to a menu item id. This is how "Menu item not found" is fixed —
   * by pointing at an existing dish, never by creating one.
   */
  aliases: z.record(z.string().trim().min(1).max(200), uuid).optional(),
};

export const previewSalesImportInput = z.object(salesImportBase);
export type PreviewSalesImportInput = z.infer<typeof previewSalesImportInput>;

export const commitSalesImportInput = z.object({
  ...salesImportBase,
  /**
   * Guards against a stale confirmation. The preview reports how many rows it
   * would import; if re-validating at commit time produces a different number —
   * because the menu changed, or another import landed first — the commit stops
   * and asks for a fresh look rather than writing something the user did not see.
   */
  expectedImportedRows: z.coerce.number().int().nonnegative(),
});
export type CommitSalesImportInput = z.infer<typeof commitSalesImportInput>;

// ------------------------------------------------------------------ transfers

/**
 * One ingredient on a transfer.
 *
 * The quantity is captured in whatever unit the user picked; the server converts
 * it to the ingredient's base unit before the ledger sees it. Positive only — a
 * negative line would be a waste record wearing a transfer's clothes, and the
 * database restates the same rule as a CHECK constraint.
 */
export const transferLineInput = z.object({
  ingredientId: uuid,
  quantity: positiveQuantity,
  unitCode: unitCode.optional(),
});
export type TransferLineInput = z.infer<typeof transferLineInput>;

/**
 * Creating a transfer.
 *
 * `sourceLocationId !== destinationLocationId` is checked here, again in the
 * action against the caller's authorized locations, and a third time as a
 * database CHECK. Three layers because the failure is silent: a transfer to
 * itself posts a matching − and + that net to zero, so it would look like it
 * worked while moving nothing.
 *
 * Duplicate ingredient lines are rejected for the same reason the database has
 * a unique index on them: two lines for beef are two answers to "how much beef
 * is moving", and a screen that groups by ingredient would show only one.
 */
export const createTransferInput = z
  .object({
    sourceLocationId: uuid,
    destinationLocationId: uuid,
    reference: optionalText(60),
    note: optionalText(500),
    items: z.array(transferLineInput).min(1, "Add at least one ingredient").max(200, "Too many lines for one transfer"),
    /** Send immediately rather than leaving a draft. */
    sendNow: z.coerce.boolean().default(false),
  })
  .superRefine((values, ctx) => {
    if (values.sourceLocationId === values.destinationLocationId) {
      ctx.addIssue({
        code: "custom",
        path: ["destinationLocationId"],
        message: "Choose a different destination — stock cannot transfer to the location it is already in.",
      });
    }

    const seen = new Set<string>();
    values.items.forEach((item, index) => {
      if (seen.has(item.ingredientId)) {
        ctx.addIssue({ code: "custom", path: ["items", index, "ingredientId"], message: "This ingredient is already on the transfer" });
      }
      seen.add(item.ingredientId);
    });
  });
export type CreateTransferInput = z.infer<typeof createTransferInput>;

export const transferIdInput = z.object({ transferId: uuid });

export const cancelTransferInput = z.object({
  transferId: uuid,
  // A cancellation without a reason gives the other site nothing to act on,
  // matching how a rejected stock count must explain itself.
  reason: shortText(300),
});
export type CancelTransferInput = z.infer<typeof cancelTransferInput>;



