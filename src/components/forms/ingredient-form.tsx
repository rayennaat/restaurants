"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { moneyInputStep } from "@/lib/money";
import type { UnitRow } from "@/lib/units";
import { ingredientInput, type IngredientInput } from "@/lib/validation";
import { saveIngredient } from "@/server/actions/ingredients";

/**
 * Zod coercion means the schema's input and output types differ (a form field
 * hands over a string, the schema yields a number). React Hook Form is typed
 * with both so `register` accepts raw values while `handleSubmit` receives the
 * parsed result.
 */
type FormInput = z.input<typeof ingredientInput>;
export type IngredientFormValues = IngredientInput;

export type IngredientFormProps = {
  units: UnitRow[];
  currency: string;
  categories?: string[];
  defaultValues?: Partial<FormInput>;
  submitLabel?: string;
  onSaved?: (id: string) => void;
  onCancel?: () => void;
};

export function IngredientForm({ units, currency, categories = [], defaultValues, submitLabel = "Save ingredient", onSaved, onCancel }: IngredientFormProps) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, IngredientFormValues>({
    resolver: zodResolver(ingredientInput),
    defaultValues: {
      name: "",
      sku: "",
      category: "",
      baseUnitCode: units.find(unit => unit.isBase)?.code ?? units[0]?.code ?? "kg",
      minimumStock: 0,
      unitCost: 0,
      isActive: true,
      ...defaultValues,
    },
  });

  async function submit(values: IngredientFormValues) {
    const result = await saveIngredient(values);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) {
        setError(field as keyof FormInput, { message });
      }
      if (!result.fieldErrors) setError("root", { message: result.error });
      return;
    }
    toast.success(defaultValues?.id ? "Ingredient updated" : "Ingredient created");
    if (!defaultValues?.id) reset();
    router.refresh();
    onSaved?.(result.data.id);
  }

  const grouped = Object.entries(
    units.reduce<Record<string, UnitRow[]>>((groups, unit) => {
      (groups[unit.dimension] ??= []).push(unit);
      return groups;
    }, {}),
  );

  return (
    <form onSubmit={handleSubmit(submit)} className="grid gap-4 sm:grid-cols-2">
      {defaultValues?.id && <input type="hidden" {...register("id")} />}

      <Field label="Name" required error={errors.name?.message} className="sm:col-span-2">
        <Input {...register("name")} placeholder="Chicken breast" autoFocus={!defaultValues?.id} />
      </Field>

      <Field label="Base unit" required error={errors.baseUnitCode?.message} hint="The unit you count and cost this ingredient in.">
        <Select {...register("baseUnitCode")}>
          {grouped.map(([dimension, dimensionUnits]) => (
            <optgroup key={dimension} label={dimension}>
              {dimensionUnits.map(unit => (
                <option key={unit.code} value={unit.code}>
                  {unit.name} ({unit.code})
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </Field>

      <Field label="Category" error={errors.category?.message} hint="Used for filtering, e.g. Meat or Produce.">
        <Input {...register("category")} placeholder="Meat" list="ingredient-categories" />
        <datalist id="ingredient-categories">
          {categories.map(category => (
            <option key={category} value={category} />
          ))}
        </datalist>
      </Field>

      <Field label="Minimum stock" error={errors.minimumStock?.message} hint="Below this level the item is flagged for reordering.">
        <Input type="number" step="0.001" min="0" {...register("minimumStock")} />
      </Field>

      <Field label={`Cost per base unit (${currency})`} error={errors.unitCost?.message} hint="Updated automatically when you receive a purchase.">
        <Input type="number" step={moneyInputStep(currency)} min="0" {...register("unitCost")} />
      </Field>

      <Field label="Supplier SKU / internal code" error={errors.sku?.message} className="sm:col-span-2">
        <Input {...register("sku")} placeholder="Optional" />
      </Field>

      {errors.root && <FormError message={errors.root.message} className="sm:col-span-2" />}

      <div className="flex gap-3 sm:col-span-2">
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
