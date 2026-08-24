"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { z } from "zod";
import { CompositionBuilder, compositionCost, type PreparationCost } from "@/components/forms/composition-builder";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { calculateMenuEconomics, foodCostTone } from "@/lib/costing";
import { formatMoney, formatPercent, moneyInputStep, toMinorUnits } from "@/lib/money";
import type { UnitRow } from "@/lib/units";
import { menuItemInput, type MenuItemInput } from "@/lib/validation";
import { saveMenuItem } from "@/server/actions/recipes";
import type { IngredientOption } from "@/server/queries/ingredients";
import type { RecipeOption } from "@/server/queries/recipes";

type FormInput = z.input<typeof menuItemInput>;

/**
 * Creates and edits a dish: what it is made of, what it sells for, and what that
 * leaves. The item owns its composition, so nothing here can reprice another
 * dish — the same dish at two prices is simply two items.
 */
export function MenuItemForm({
  ingredients,
  preparations,
  preparationCosts,
  units,
  currency,
  defaultValues,
  submitLabel = "Save menu item",
  onSaved,
  onCancel,
}: {
  ingredients: IngredientOption[];
  /** Preparations selectable as lines. */
  preparations: RecipeOption[];
  /** Cost per yield unit for each preparation, for the live preview. */
  preparationCosts: PreparationCost[];
  units: UnitRow[];
  currency: string;
  defaultValues?: Partial<FormInput>;
  submitLabel?: string;
  onSaved?: (id: string) => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, MenuItemInput>({
    resolver: zodResolver(menuItemInput),
    defaultValues: {
      name: "",
      category: "",
      yieldQuantity: 1,
      sellingPrice: 0,
      packagingCost: 0,
      isActive: true,
      items: [{ kind: "ingredient", ingredientId: "", componentRecipeId: "", quantity: 1, unitCode: "" }],
      ...defaultValues,
    },
  });

  const items = watch("items");
  const sellingPrice = watch("sellingPrice");
  const packagingCost = watch("packagingCost");
  const yieldQuantity = watch("yieldQuantity");

  // Priced client-side from the same ingredient costs and unit multipliers the
  // server uses, so the margin shown while typing matches what gets saved.
  const batchCostMillis = compositionCost(items, ingredients, preparationCosts, units);
  const portions = Number(yieldQuantity) || 1;
  const economics = calculateMenuEconomics({
    sellingPriceMillis: toMinorUnits(Number(sellingPrice) || 0, currency),
    recipeCostMillis: Math.round(batchCostMillis / portions),
    packagingCostMillis: toMinorUnits(Number(packagingCost) || 0, currency),
    isCosted: Boolean(items?.length),
  });

  async function submit(values: MenuItemInput) {
    const result = await saveMenuItem(values);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) setError(field as keyof FormInput, { message });
      if (!result.fieldErrors) setError("root", { message: result.error });
      toast.error(result.error);
      return;
    }
    toast.success(defaultValues?.id ? "Menu item updated" : "Menu item created");
    if (!defaultValues?.id) reset();
    router.refresh();
    onSaved?.(result.data.id);
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-5">
      {defaultValues?.id && <input type="hidden" {...register("id")} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Item name" required error={errors.name?.message} className="sm:col-span-2">
          <Input {...register("name")} placeholder="Crispy chicken burger" autoFocus={!defaultValues?.id} />
        </Field>

        <Field label={`Selling price (${currency})`} required error={errors.sellingPrice?.message}>
          <Input type="number" step={moneyInputStep(currency)} min="0" {...register("sellingPrice")} />
        </Field>

        <Field label={`Packaging cost (${currency})`} error={errors.packagingCost?.message} hint="Box, bag, cutlery.">
          <Input type="number" step={moneyInputStep(currency)} min="0" {...register("packagingCost")} />
        </Field>

        <Field label="Category" error={errors.category?.message} className="sm:col-span-2">
          <Input {...register("category")} placeholder="Burgers" />
        </Field>
      </div>

      <CompositionBuilder
        control={control}
        register={register}
        watch={watch}
        setValue={setValue}
        errors={errors}
        ingredients={ingredients}
        preparations={preparations}
        units={units}
        emptyHint="Add the ingredients and preparations that go into this dish."
      />

      <Field label="Portions per batch" error={errors.yieldQuantity?.message} hint="Leave at 1 when the lines above describe a single serving." className="max-w-48">
        <Input type="number" step="0.001" min="0" {...register("yieldQuantity")} />
      </Field>

      <div className="rounded-lg border bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-[.15em] text-[var(--muted)]">Cost per portion</p>
            <b className="text-xl tabular-nums">{formatMoney(economics.totalCostMillis, currency)}</b>
          </div>
          <div className="text-right">
            <p className="text-xs font-black uppercase tracking-[.15em] text-[var(--muted)]">Gross profit</p>
            <b className={`text-xl tabular-nums ${economics.grossProfitMillis < 0 ? "text-red-700" : "text-green-800"}`}>{formatMoney(economics.grossProfitMillis, currency)}</b>
          </div>
          <div className="flex gap-2">
            <Badge tone={foodCostTone(economics.foodCostPercent)}>{formatPercent(economics.foodCostPercent)} food cost</Badge>
            <Badge tone="neutral">{formatPercent(economics.grossMarginPercent)} margin</Badge>
          </div>
        </div>
        <p className="mt-2 text-xs text-[var(--muted)]">Recalculated live from current ingredient prices, and again on every load — so this dish re-prices itself whenever a cost changes.</p>
      </div>

      {errors.root && <FormError message={errors.root.message} />}

      <div className="flex gap-3">
        <Button className="flex-1" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
