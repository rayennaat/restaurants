"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useFieldArray, useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { compatibleUnits, type UnitRow } from "@/lib/units";
import { recipeInput, type RecipeInput } from "@/lib/validation";
import { saveRecipe } from "@/server/actions/recipes";
import type { IngredientOption } from "@/server/queries/ingredients";
import type { RecipeWithCosting } from "@/server/queries/recipes";

type FormInput = z.input<typeof recipeInput>;

export function RecipeForm({
  recipe,
  ingredients,
  units,
  onSuccess,
}: {
  recipe?: RecipeWithCosting;
  ingredients: IngredientOption[];
  units: UnitRow[];
  onSuccess?: () => void;
}) {
  const router = useRouter();
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { isSubmitting, errors },
  } = useForm<FormInput, unknown, RecipeInput>({
    resolver: zodResolver(recipeInput),
    defaultValues: recipe
      ? {
          id: recipe.id,
          name: recipe.name,
          yieldQuantity: recipe.yieldQuantity,
          yieldUnitCode: recipe.yieldUnitCode ?? "",
          notes: recipe.notes ?? "",
          items: recipe.lines.map(line => ({
            ingredientId: line.ingredientId,
            quantity: line.quantity,
            unitCode: line.unitCode ?? line.baseUnitCode,
          })),
        }
      : {
          name: "",
          yieldQuantity: 1,
          yieldUnitCode: "portion",
          notes: "",
          items: [{ ingredientId: "", quantity: 1, unitCode: "" }],
        },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "items" });

  async function submit(values: RecipeInput) {
    const result = await saveRecipe(values);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(recipe ? "Recipe updated" : "Recipe created");
    router.refresh();
    onSuccess?.();
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-6">
      <Field label="Recipe name" required error={errors.name?.message}>
        <Input {...register("name")} placeholder="Tomato basil soup" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Yield" required error={errors.yieldQuantity?.message}>
          <Input type="number" step="0.01" min="0" {...register("yieldQuantity")} />
        </Field>
        <Field label="Yield unit" hint="What one batch produces.">
          <Select {...register("yieldUnitCode")}>
            <option value="portion">portion</option>
            <option value="serving">serving</option>
            {units.map(unit => (
              <option key={unit.code} value={unit.code}>
                {unit.name} ({unit.code})
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">Ingredients</label>
          <Button type="button" variant="secondary" size="sm" onClick={() => append({ ingredientId: "", quantity: 1, unitCode: "" })}>
            + Add line
          </Button>
        </div>

        {fields.map((field, index) => {
          const selectedId = watch(`items.${index}.ingredientId`);
          const ingredient = ingredients.find(item => item.id === selectedId);
          const unitOptions = ingredient ? compatibleUnits(units, ingredient.baseUnitCode) : units;

          return (
            <div key={field.id} className="grid grid-cols-[2fr_1fr_1fr_auto] gap-2 items-start">
              <Field error={errors.items?.[index]?.ingredientId?.message}>
                <Select
                  {...register(`items.${index}.ingredientId`, {
                    onChange: event => {
                      const picked = ingredients.find(entry => entry.id === event.target.value);
                      if (picked) setValue(`items.${index}.unitCode`, picked.baseUnitCode, { shouldValidate: true });
                    },
                  })}
                >
                  <option value="">Select ingredient…</option>
                  {ingredients.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field error={errors.items?.[index]?.quantity?.message}>
                <Input type="number" step="0.001" min="0" {...register(`items.${index}.quantity`)} />
              </Field>

              <Field error={errors.items?.[index]?.unitCode?.message}>
                <Select {...register(`items.${index}.unitCode`)}>
                  {unitOptions.map(unit => (
                    <option key={unit.code} value={unit.code}>
                      {unit.code}
                    </option>
                  ))}
                </Select>
              </Field>

              {fields.length > 1 && (
                <button type="button" className="mt-2 text-[var(--muted)] hover:text-[var(--danger)]" onClick={() => remove(index)}>
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>

      <Field label="Notes">
        <Textarea {...register("notes")} rows={3} placeholder="Preparation tips, storage, variations…" />
      </Field>

      <div className="flex gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : recipe ? "Save changes" : "Create recipe"}
        </Button>
        {onSuccess && (
          <Button type="button" variant="secondary" onClick={onSuccess}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
