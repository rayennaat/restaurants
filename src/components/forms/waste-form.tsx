"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { compatibleUnits, type UnitRow } from "@/lib/units";
import { wasteInput, type WasteInput } from "@/lib/validation";
import { submitOrQueue } from "@/lib/offline/db";
import type { IngredientOption } from "@/server/queries/ingredients";

type FormInput = z.input<typeof wasteInput>;

export function WasteForm({
  ingredients,
  units,
  locationId,
}: {
  ingredients: IngredientOption[];
  units: UnitRow[];
  locationId: string;
}) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { isSubmitting },
  } = useForm<FormInput, unknown, WasteInput>({
    resolver: zodResolver(wasteInput),
    defaultValues: { ingredientId: "", quantity: 1, reason: "expired", note: "", locationId },
  });

  const selectedId = watch("ingredientId");
  const ingredient = ingredients.find(item => item.id === selectedId);
  const unitOptions = ingredient ? compatibleUnits(units, ingredient.baseUnitCode) : units;

  async function submit(values: WasteInput) {
    const result = await submitOrQueue("/api/waste", values);
    toast.success(result.queued ? "Waste entry queued offline — it will sync later" : "Waste recorded and deducted from stock");
    reset({ ingredientId: "", quantity: 1, reason: "expired", note: "", locationId });
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-4">
      <input type="hidden" {...register("locationId")} />

      <Field label="Ingredient" required>
        <Select
          {...register("ingredientId", {
            onChange: event => {
              const ing = ingredients.find(item => item.id === event.target.value);
              if (ing) setValue("unitCode", ing.baseUnitCode);
            },
          })}
        >
          <option value="">Select ingredient…</option>
          {ingredients
            .filter(item => item.unitCostMillis > 0)
            .map(item => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.baseUnitCode})
              </option>
            ))}
        </Select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Quantity" required>
          <Input type="number" step="0.001" min="0" {...register("quantity")} />
        </Field>

        <Field label="Unit">
          <Select {...register("unitCode")}>
            {unitOptions.map(unit => (
              <option key={unit.code} value={unit.code}>
                {unit.code}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Reason" required>
        <Select {...register("reason")}>
          <option value="expired">Expired</option>
          <option value="damaged">Damaged</option>
          <option value="overproduction">Overproduction</option>
          <option value="preparation_error">Preparation error</option>
          <option value="quality_issue">Quality issue</option>
          <option value="other">Other</option>
        </Select>
      </Field>

      <Field label="Note">
        <Input {...register("note")} placeholder="What happened, briefly" />
      </Field>

      <Button className="w-full" disabled={isSubmitting}>
        {isSubmitting ? "Recording…" : "Record waste & deduct stock"}
      </Button>
    </form>
  );
}
