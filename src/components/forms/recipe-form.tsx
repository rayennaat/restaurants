"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useFieldArray, useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { ChefHat, Plus, Soup, X } from "lucide-react";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { compatibleUnits, type UnitRow } from "@/lib/units";
import { recipeInput, type RecipeInput } from "@/lib/validation";
import { saveRecipe } from "@/server/actions/recipes";
import type { IngredientOption } from "@/server/queries/ingredients";
import type { RecipeOption, RecipeWithCosting } from "@/server/queries/recipes";

type FormInput = z.input<typeof recipeInput>;

export function RecipeForm({
  recipe,
  ingredients,
  preparations,
  units,
  onSuccess,
}: {
  recipe?: RecipeWithCosting;
  ingredients: IngredientOption[];
  /** Recipes selectable as sub-preparations. Excludes the recipe being edited. */
  preparations: RecipeOption[];
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
    setError,
    formState: { isSubmitting, errors },
  } = useForm<FormInput, unknown, RecipeInput>({
    resolver: zodResolver(recipeInput),
    defaultValues: recipe
      ? {
          id: recipe.id,
          name: recipe.name,
          yieldQuantity: recipe.yieldQuantity,
          yieldUnitCode: recipe.yieldUnitCode ?? "",
          isPreparation: recipe.isPreparation,
          notes: recipe.notes ?? "",
          items: recipe.lines.map(line => ({
            kind: line.kind,
            ingredientId: line.kind === "ingredient" ? line.targetId : "",
            componentRecipeId: line.kind === "recipe" ? line.targetId : "",
            quantity: line.quantity,
            unitCode: line.unitCode ?? line.baseUnitCode,
          })),
        }
      : {
          name: "",
          yieldQuantity: 1,
          yieldUnitCode: "portion",
          isPreparation: false,
          notes: "",
          items: [{ kind: "ingredient", ingredientId: "", componentRecipeId: "", quantity: 1, unitCode: "" }],
        },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "items" });
  const canUsePreparations = preparations.length > 0;

  async function submit(values: RecipeInput) {
    const result = await saveRecipe(values);
    if (!result.ok) {
      if (result.fieldErrors?.items) setError("items", { message: result.fieldErrors.items });
      else setError("root", { message: result.error });
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
        <Field label="Yield" required error={errors.yieldQuantity?.message} hint="What one batch produces.">
          <Input type="number" step="0.001" min="0" {...register("yieldQuantity")} />
        </Field>
        <Field label="Yield unit" error={errors.yieldUnitCode?.message}>
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

      <label className="flex cursor-pointer gap-3 rounded-xl border bg-neutral-50/60 p-3.5 text-sm transition hover:bg-neutral-50">
        <input type="checkbox" {...register("isPreparation")} className="mt-0.5 size-4 accent-green-700" />
        <span>
          <b className="flex items-center gap-1.5">
            <Soup size={15} /> This is a preparation, not a dish
          </b>
          <span className="mt-0.5 block text-[var(--muted)]">
            Preparations like mayonnaise, stock or dough are made in batches and used inside other recipes. Measure the yield in a real unit (kg, L) so dishes can consume a portion of it.
          </span>
        </span>
      </label>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Recipe lines</span>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => append({ kind: "ingredient", ingredientId: "", componentRecipeId: "", quantity: 1, unitCode: "" })}>
              <Plus size={15} /> Ingredient
            </Button>
            {canUsePreparations && (
              <Button type="button" variant="secondary" size="sm" onClick={() => append({ kind: "recipe", ingredientId: "", componentRecipeId: "", quantity: 1, unitCode: "" })}>
                <Plus size={15} /> Preparation
              </Button>
            )}
          </div>
        </div>

        {fields.map((field, index) => {
          const kind = watch(`items.${index}.kind`);
          const lineErrors = errors.items?.[index];

          if (kind === "recipe") {
            const selectedId = watch(`items.${index}.componentRecipeId`);
            const selected = preparations.find(option => option.id === selectedId);
            const yieldUnit = selected?.yieldUnitCode ?? null;
            const unitOptions = yieldUnit ? compatibleUnits(units, yieldUnit) : [];

            return (
              <div key={field.id} className="grid grid-cols-[2fr_1fr_1fr_auto] items-start gap-2 rounded-xl border border-amber-200/70 bg-amber-50/40 p-2">
                <Field error={lineErrors?.componentRecipeId?.message}>
                  <Select
                    {...register(`items.${index}.componentRecipeId`, {
                      onChange: event => {
                        const picked = preparations.find(option => option.id === event.target.value);
                        if (picked?.yieldUnitCode) setValue(`items.${index}.unitCode`, picked.yieldUnitCode, { shouldValidate: true });
                      },
                    })}
                  >
                    <option value="">Select a preparation…</option>
                    {preparations.map(option => (
                      <option key={option.id} value={option.id}>
                        {option.name} (makes {Number(option.yieldQuantity)} {option.yieldUnitCode ?? "portion"})
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field error={lineErrors?.quantity?.message}>
                  <Input type="number" step="0.001" min="0" {...register(`items.${index}.quantity`)} />
                </Field>

                <Field error={lineErrors?.unitCode?.message}>
                  <Select {...register(`items.${index}.unitCode`)}>
                    {yieldUnit && !unitOptions.some(unit => unit.code === yieldUnit) && <option value={yieldUnit}>{yieldUnit}</option>}
                    {unitOptions.map(unit => (
                      <option key={unit.code} value={unit.code}>
                        {unit.code}
                      </option>
                    ))}
                  </Select>
                </Field>

                <RemoveLine onClick={() => remove(index)} disabled={fields.length === 1} />
                <input type="hidden" {...register(`items.${index}.kind`)} />
              </div>
            );
          }

          const selectedId = watch(`items.${index}.ingredientId`);
          const ingredient = ingredients.find(item => item.id === selectedId);
          const unitOptions = ingredient ? compatibleUnits(units, ingredient.baseUnitCode) : units;

          return (
            <div key={field.id} className="grid grid-cols-[2fr_1fr_1fr_auto] items-start gap-2 rounded-xl border border-transparent p-2">
              <Field error={lineErrors?.ingredientId?.message}>
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

              <Field error={lineErrors?.quantity?.message}>
                <Input type="number" step="0.001" min="0" {...register(`items.${index}.quantity`)} />
              </Field>

              <Field error={lineErrors?.unitCode?.message}>
                <Select {...register(`items.${index}.unitCode`)}>
                  {unitOptions.map(unit => (
                    <option key={unit.code} value={unit.code}>
                      {unit.code}
                    </option>
                  ))}
                </Select>
              </Field>

              <RemoveLine onClick={() => remove(index)} disabled={fields.length === 1} />
              <input type="hidden" {...register(`items.${index}.kind`)} />
            </div>
          );
        })}

        {typeof errors.items?.message === "string" && <FormError message={errors.items.message} />}
        {!canUsePreparations && (
          <p className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <ChefHat size={14} /> Save a recipe as a preparation to reuse it inside other recipes.
          </p>
        )}
      </div>

      <Field label="Notes">
        <Textarea {...register("notes")} rows={3} placeholder="Preparation tips, storage, variations…" />
      </Field>

      {errors.root && <FormError message={errors.root.message} />}

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

function RemoveLine({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      aria-label="Remove line"
      onClick={onClick}
      disabled={disabled}
      className="mt-2.5 rounded-lg p-1 text-[var(--muted)] transition hover:bg-red-50 hover:text-[var(--danger)] disabled:pointer-events-none disabled:opacity-30"
    >
      <X size={16} />
    </button>
  );
}
