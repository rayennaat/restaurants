"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { Soup } from "lucide-react";
import { toast } from "sonner";
import type { z } from "zod";
import { CompositionBuilder } from "@/components/forms/composition-builder";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { UnitRow } from "@/lib/units";
import { recipeInput, type RecipeInput } from "@/lib/validation";
import { saveRecipe } from "@/server/actions/recipes";
import type { IngredientOption } from "@/server/queries/ingredients";
import type { RecipeOption, RecipeWithCosting } from "@/server/queries/recipes";

type FormInput = z.input<typeof recipeInput>;

/**
 * Creates and edits a preparation — something made in batches and consumed by
 * dishes. Dishes themselves are composed on the Menu page, where their price
 * and margin live.
 */
export function RecipeForm({
  recipe,
  ingredients,
  preparations,
  units,
  onSuccess,
}: {
  recipe?: RecipeWithCosting;
  ingredients: IngredientOption[];
  /** Other preparations selectable as sub-preparations. Excludes the one being edited. */
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
          yieldUnitCode: "kg",
          notes: "",
          items: [{ kind: "ingredient", ingredientId: "", componentRecipeId: "", quantity: 1, unitCode: "" }],
        },
  });

  async function submit(values: RecipeInput) {
    const result = await saveRecipe(values);
    if (!result.ok) {
      if (result.fieldErrors?.items) setError("items", { message: result.fieldErrors.items });
      else setError("root", { message: result.error });
      toast.error(result.error);
      return;
    }
    toast.success(recipe ? "Preparation updated" : "Preparation created");
    router.refresh();
    onSuccess?.();
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-6">
      <Field label="Preparation name" required error={errors.name?.message}>
        <Input {...register("name")} placeholder="House mayonnaise" />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Batch yield" required error={errors.yieldQuantity?.message} hint="What one batch produces.">
          <Input type="number" step="0.001" min="0" {...register("yieldQuantity")} />
        </Field>
        <Field label="Yield unit" error={errors.yieldUnitCode?.message} hint="Dishes consume the batch in this unit.">
          <Select {...register("yieldUnitCode")}>
            {units.map(unit => (
              <option key={unit.code} value={unit.code}>
                {unit.name} ({unit.code})
              </option>
            ))}
            <option value="portion">portion</option>
          </Select>
        </Field>
      </div>

      <p className="flex gap-2.5 rounded-xl border bg-neutral-50/60 p-3.5 text-sm text-[var(--muted)]">
        <Soup size={16} className="mt-0.5 shrink-0 text-green-700" />
        <span>
          A preparation is made in batches and used inside your dishes — mayonnaise, stock, dough. Measure the yield in a real unit (kg, L) so a dish can consume part of a
          batch. Dishes themselves are built on the Menu page.
        </span>
      </p>

      <CompositionBuilder
        control={control}
        register={register}
        watch={watch}
        setValue={setValue}
        errors={errors}
        ingredients={ingredients}
        preparations={preparations}
        units={units}
        label="What goes into one batch"
        emptyHint="Add the ingredients and preparations that make up one batch."
      />

      <Field label="Notes">
        <Textarea {...register("notes")} rows={3} placeholder="Preparation tips, storage, variations…" />
      </Field>

      {errors.root && <FormError message={errors.root.message} />}

      <div className="flex gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : recipe ? "Save changes" : "Create preparation"}
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

