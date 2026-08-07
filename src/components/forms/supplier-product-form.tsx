"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { moneyInputStep } from "@/lib/money";
import { compatibleUnits, type UnitRow } from "@/lib/units";
import { supplierProductInput, type SupplierProductInput } from "@/lib/validation";
import { saveSupplierProduct } from "@/server/actions/suppliers";
import type { IngredientOption } from "@/server/queries/ingredients";

type FormInput = z.input<typeof supplierProductInput>;

export function SupplierProductForm({
  supplierId,
  ingredients,
  units,
  currency,
  defaultValues,
  submitLabel = "Add product",
  onSaved,
  onCancel,
}: {
  supplierId: string;
  ingredients: IngredientOption[];
  units: UnitRow[];
  currency: string;
  defaultValues?: Partial<FormInput>;
  submitLabel?: string;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, SupplierProductInput>({
    resolver: zodResolver(supplierProductInput),
    defaultValues: {
      supplierId,
      ingredientId: "",
      supplierSku: "",
      packQuantity: 1,
      packUnitCode: "",
      unitPrice: 0,
      isActive: true,
      ...defaultValues,
    },
  });

  const selectedIngredientId = watch("ingredientId");
  const selectedIngredient = ingredients.find(item => item.id === selectedIngredientId);

  // Only offer units in the same dimension as the ingredient's base unit, so a
  // kilogram ingredient can never be priced in litres.
  const unitOptions = useMemo(() => (selectedIngredient ? compatibleUnits(units, selectedIngredient.baseUnitCode) : units), [selectedIngredient, units]);

  async function submit(values: SupplierProductInput) {
    const result = await saveSupplierProduct(values);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) setError(field as keyof FormInput, { message });
      if (!result.fieldErrors) setError("root", { message: result.error });
      return;
    }
    toast.success(defaultValues?.id ? "Product updated" : "Product added to this supplier");
    if (!defaultValues?.id) reset({ supplierId, ingredientId: "", supplierSku: "", packQuantity: 1, packUnitCode: "", unitPrice: 0, isActive: true });
    router.refresh();
    onSaved?.();
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" {...register("supplierId")} />
      {defaultValues?.id && <input type="hidden" {...register("id")} />}

      <Field label="Ingredient" required error={errors.ingredientId?.message} className="sm:col-span-2">
        <Select
          {...register("ingredientId")}
          disabled={Boolean(defaultValues?.id)}
          onChange={event => {
            setValue("ingredientId", event.target.value, { shouldValidate: true });
            const ingredient = ingredients.find(item => item.id === event.target.value);
            // Default the pack unit to the ingredient's own base unit.
            if (ingredient) setValue("packUnitCode", ingredient.baseUnitCode);
          }}
        >
          <option value="">Select an ingredient…</option>
          {ingredients.map(ingredient => (
            <option key={ingredient.id} value={ingredient.id}>
              {ingredient.name} ({ingredient.baseUnitCode})
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Supplier SKU" error={errors.supplierSku?.message} hint="The code on their price list or invoice.">
        <Input {...register("supplierSku")} placeholder="Optional" />
      </Field>

      <Field label="Pack quantity" required error={errors.packQuantity?.message} hint="How much one package contains.">
        <Input type="number" step="0.001" min="0" {...register("packQuantity")} />
      </Field>

      <Field label="Pack unit" required error={errors.packUnitCode?.message}>
        <Select {...register("packUnitCode")}>
          <option value="">Select a unit…</option>
          {unitOptions.map(unit => (
            <option key={unit.code} value={unit.code}>
              {unit.name} ({unit.code})
            </option>
          ))}
        </Select>
      </Field>

      <Field label={`Price per unit (${currency})`} required error={errors.unitPrice?.message} hint="Refreshed automatically when you receive an invoice.">
        <Input type="number" step={moneyInputStep(currency)} min="0" {...register("unitPrice")} />
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
