"use client";

import {
  useFieldArray,
  type Control,
  type FieldArrayPath,
  type FieldErrors,
  type FieldValues,
  type Path,
  type UseFormRegister,
  type UseFormSetValue,
  type UseFormWatch,
} from "react-hook-form";
import { Plus, Soup, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { compatibleUnits, type UnitRow } from "@/lib/units";
import type { IngredientOption } from "@/server/queries/ingredients";
import type { RecipeOption } from "@/server/queries/recipes";

/**
 * The ingredient + preparation line editor shared by the recipe form and the
 * menu item form, so a dish is composed the same way wherever it is created.
 *
 * The parent owns the form; this component only manages the `items` field
 * array. Both schemas expose an identically shaped `items` array, which is what
 * makes the sharing safe.
 */

/** One composition line. `kind` is optional because zod input types widen it. */
export type LineValue = {
  kind?: "ingredient" | "recipe";
  ingredientId?: string;
  componentRecipeId?: string;
  quantity?: number | string | unknown;
  unitCode?: string;
};

/** Shape of the per-line errors the builder renders, whatever the parent form is. */
type LineErrors = Partial<Record<keyof LineValue, { message?: string }>>;

const emptyLine = (kind: "ingredient" | "recipe") => ({ kind, ingredientId: "", componentRecipeId: "", quantity: 1, unitCode: "" });

/**
 * Generic over the parent form so RHF's invariant `Control` type still matches:
 * any form carrying an `items` field array of composition lines can use this.
 */
export function CompositionBuilder<TFieldValues extends FieldValues>({
  control,
  register,
  watch,
  setValue,
  errors,
  ingredients,
  preparations,
  units,
  label = "What's in it",
  emptyHint,
}: {
  control: Control<TFieldValues>;
  register: UseFormRegister<TFieldValues>;
  watch: UseFormWatch<TFieldValues>;
  setValue: UseFormSetValue<TFieldValues>;
  errors: FieldErrors<TFieldValues>;
  ingredients: IngredientOption[];
  preparations: RecipeOption[];
  units: UnitRow[];
  label?: string;
  emptyHint?: string;
}) {
  const { fields, append, remove } = useFieldArray({ control, name: "items" as FieldArrayPath<TFieldValues> });
  const canUsePreparations = preparations.length > 0;
  const itemErrors = errors.items as { message?: string } & (LineErrors | undefined)[] | undefined;

  // `items.N.field` paths are valid on every parent form but not provable in the
  // generic, so the path strings are narrowed at the call sites below.
  const path = (index: number, field: keyof LineValue) => `items.${index}.${field}` as Path<TFieldValues>;
  const read = (index: number, field: keyof LineValue) => watch(path(index, field)) as string | undefined;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-semibold">{label}</span>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => append(emptyLine("ingredient") as never)}>
            <Plus size={15} /> Ingredient
          </Button>
          {canUsePreparations && (
            <Button type="button" variant="secondary" size="sm" onClick={() => append(emptyLine("recipe") as never)}>
              <Plus size={15} /> Preparation
            </Button>
          )}
        </div>
      </div>

      {fields.length === 0 && (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-[var(--muted)]">
          {emptyHint ?? "Add the ingredients and preparations that make up this item."}
        </p>
      )}

      {fields.map((field, index) => {
        const kind = (read(index, "kind") ?? "ingredient") as "ingredient" | "recipe";
        const lineErrors: LineErrors | undefined = Array.isArray(itemErrors) ? itemErrors[index] : undefined;

        if (kind === "recipe") {
          const selectedId = read(index, "componentRecipeId");
          const selected = preparations.find(option => option.id === selectedId);
          const yieldUnit = selected?.yieldUnitCode ?? null;
          const unitOptions = yieldUnit ? compatibleUnits(units, yieldUnit) : [];

          return (
            <div key={field.id} className="grid grid-cols-[2fr_1fr_1fr_auto] items-start gap-2 rounded-lg border border-amber-200/70 bg-amber-50/40 p-2">
              <Field error={lineErrors?.componentRecipeId?.message}>
                <Select
                  {...register(path(index, "componentRecipeId"), {
                    onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                      const picked = preparations.find(option => option.id === event.target.value);
                      if (picked?.yieldUnitCode) setValue(path(index, "unitCode"), picked.yieldUnitCode as never, { shouldValidate: true });
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
                <Input type="number" step="0.001" min="0" {...register(path(index, "quantity"))} />
              </Field>

              <Field error={lineErrors?.unitCode?.message}>
                <Select {...register(path(index, "unitCode"))}>
                  {yieldUnit && !unitOptions.some(unit => unit.code === yieldUnit) && <option value={yieldUnit}>{yieldUnit}</option>}
                  {unitOptions.map(unit => (
                    <option key={unit.code} value={unit.code}>
                      {unit.code}
                    </option>
                  ))}
                </Select>
              </Field>

              <RemoveLine onClick={() => remove(index)} />
              <input type="hidden" {...register(path(index, "kind"))} />
            </div>
          );
        }

        const selectedId = read(index, "ingredientId");
        const ingredient = ingredients.find(item => item.id === selectedId);
        const unitOptions = ingredient ? compatibleUnits(units, ingredient.baseUnitCode) : units;

        return (
          <div key={field.id} className="grid grid-cols-[2fr_1fr_1fr_auto] items-start gap-2 rounded-lg border border-transparent p-2">
            <Field error={lineErrors?.ingredientId?.message}>
              <Select
                {...register(path(index, "ingredientId"), {
                  onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                    const picked = ingredients.find(entry => entry.id === event.target.value);
                    if (picked) setValue(path(index, "unitCode"), picked.baseUnitCode as never, { shouldValidate: true });
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
              <Input type="number" step="0.001" min="0" {...register(path(index, "quantity"))} />
            </Field>

            <Field error={lineErrors?.unitCode?.message}>
              <Select {...register(path(index, "unitCode"))}>
                {unitOptions.map(unit => (
                  <option key={unit.code} value={unit.code}>
                    {unit.code}
                  </option>
                ))}
              </Select>
            </Field>

            <RemoveLine onClick={() => remove(index)} />
            <input type="hidden" {...register(path(index, "kind"))} />
          </div>
        );
      })}

      {typeof itemErrors?.message === "string" && <FormError message={itemErrors.message} />}
      {!canUsePreparations && (
        <p className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
          <Soup size={14} /> Mark a recipe as a preparation to reuse it here.
        </p>
      )}
    </div>
  );
}

function RemoveLine({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Remove line"
      onClick={onClick}
      className="mt-2.5 rounded-lg p-1 text-[var(--muted)] transition hover:bg-red-50 hover:text-[var(--danger)]"
    >
      <X size={16} />
    </button>
  );
}

/** A preparation the builder can cost: its cost for one of its own yield units. */
export type PreparationCost = { id: string; yieldUnitCode: string | null; costPerYieldUnitMillis: number };

/**
 * Cost of the lines currently in the form, in minor units.
 *
 * Computed from the same ingredient costs and unit multipliers the server uses,
 * so the margin shown while typing matches what gets saved.
 */
export function compositionCost(lines: LineValue[] | undefined, ingredients: IngredientOption[], preparations: PreparationCost[], units: UnitRow[]) {
  if (!lines?.length) return 0;

  return lines.reduce((total, line) => {
    const quantity = Number(line.quantity) || 0;
    if (!quantity) return total;

    if (line.kind === "recipe") {
      const preparation = preparations.find(entry => entry.id === line.componentRecipeId);
      if (!preparation?.yieldUnitCode) return total;
      return total + convert(quantity, line.unitCode, preparation.yieldUnitCode, units) * preparation.costPerYieldUnitMillis;
    }

    const ingredient = ingredients.find(entry => entry.id === line.ingredientId);
    if (!ingredient) return total;
    return total + convert(quantity, line.unitCode, ingredient.baseUnitCode, units) * ingredient.unitCostMillis;
  }, 0);
}

function convert(quantity: number, fromCode: string | null | undefined, baseCode: string, units: UnitRow[]) {
  if (!fromCode || fromCode === baseCode) return quantity;
  const from = units.find(unit => unit.code === fromCode);
  const base = units.find(unit => unit.code === baseCode);
  if (!from || !base || from.dimension !== base.dimension) return quantity;
  return (quantity * Number(from.multiplierToBase)) / Number(base.multiplierToBase);
}
