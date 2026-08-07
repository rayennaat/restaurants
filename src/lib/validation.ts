import { z } from "zod";
import { SUPPORTED_CURRENCIES } from "./money";
import { UNIT_DIMENSIONS } from "./units";

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

// ---------------------------------------------------------------------- recipe

/**
 * One recipe line. `kind` selects the target: a raw ingredient, or another
 * recipe used as a preparation. The unused id is dropped so the DB check
 * constraint (exactly one target) is always satisfied.
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

export const recipeInput = z.object({
  id: optionalUuid,
  name: shortText(120),
  /** Servings or batch quantity produced by one production run. */
  yieldQuantity: positiveQuantity.default(1),
  yieldUnitCode: optionalText(24),
  /** True for preparations consumed by other recipes rather than sold directly. */
  isPreparation: z.coerce.boolean().default(false),
  notes: optionalText(2000),
  isActive: z.coerce.boolean().default(true),
  items: z
    .array(recipeIngredientInput)
    .min(1, "A recipe needs at least one line")
    .max(100)
    .superRefine((items, ctx) => {
      const seenIngredients = new Set<string>();
      const seenRecipes = new Set<string>();
      items.forEach((item, index) => {
        const key = item.kind === "recipe" ? item.componentRecipeId! : item.ingredientId!;
        const seen = item.kind === "recipe" ? seenRecipes : seenIngredients;
        if (seen.has(key)) {
          ctx.addIssue({
            code: "custom",
            path: [index, item.kind === "recipe" ? "componentRecipeId" : "ingredientId"],
            message: item.kind === "recipe" ? "This preparation is already on the recipe" : "This ingredient is already on the recipe",
          });
        }
        seen.add(key);
      });
    }),
});
export type RecipeInput = z.infer<typeof recipeInput>;

// ------------------------------------------------------------------- menu item

export const menuItemInput = z.object({
  id: optionalUuid,
  name: shortText(120),
  category: optionalText(60),
  recipeId: optionalUuid,
  /** Menu price, in major currency units. */
  sellingPrice: majorMoney,
  /** Packaging/consumable cost per sale, in major currency units. */
  packagingCost: majorMoney.default(0),
  isActive: z.coerce.boolean().default(true),
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
