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
import { menuItemInput, type MenuItemInput } from "@/lib/validation";
import { saveMenuItem } from "@/server/actions/recipes";

type FormInput = z.input<typeof menuItemInput>;

export function MenuItemForm({
  recipes,
  currency,
  defaultValues,
  submitLabel = "Save menu item",
  onSaved,
  onCancel,
}: {
  recipes: { id: string; name: string }[];
  currency: string;
  defaultValues?: Partial<FormInput>;
  submitLabel?: string;
  onSaved?: (id: string) => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, MenuItemInput>({
    resolver: zodResolver(menuItemInput),
    defaultValues: { name: "", category: "", recipeId: "", sellingPrice: 0, packagingCost: 0, isActive: true, ...defaultValues },
  });

  async function submit(values: MenuItemInput) {
    const result = await saveMenuItem(values);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) setError(field as keyof FormInput, { message });
      if (!result.fieldErrors) setError("root", { message: result.error });
      return;
    }
    toast.success(defaultValues?.id ? "Menu item updated" : "Menu item created");
    if (!defaultValues?.id) reset();
    router.refresh();
    onSaved?.(result.data.id);
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="grid gap-4 sm:grid-cols-2">
      {defaultValues?.id && <input type="hidden" {...register("id")} />}

      <Field label="Item name" required error={errors.name?.message} className="sm:col-span-2">
        <Input {...register("name")} placeholder="Crispy chicken burger" autoFocus={!defaultValues?.id} />
      </Field>

      <Field label="Recipe" error={errors.recipeId?.message} hint="Links this item to a live ingredient cost." className="sm:col-span-2">
        <Select {...register("recipeId")}>
          <option value="">No recipe linked</option>
          {recipes.map(recipe => (
            <option key={recipe.id} value={recipe.id}>
              {recipe.name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label={`Selling price (${currency})`} required error={errors.sellingPrice?.message}>
        <Input type="number" step={moneyInputStep(currency)} min="0" {...register("sellingPrice")} />
      </Field>

      <Field label={`Packaging cost (${currency})`} error={errors.packagingCost?.message} hint="Box, bag, cutlery — counted against margin.">
        <Input type="number" step={moneyInputStep(currency)} min="0" {...register("packagingCost")} />
      </Field>

      <Field label="Category" error={errors.category?.message} className="sm:col-span-2">
        <Input {...register("category")} placeholder="Burgers" />
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
