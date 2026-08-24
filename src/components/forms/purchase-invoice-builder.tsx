"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useFieldArray, useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { CalendarDays, FileText, MapPin, Minus, PackagePlus, Plus, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { moneyInputStep, toMajorUnits } from "@/lib/money";
import { compatibleUnits, type UnitRow } from "@/lib/units";
import { purchaseInput, type PurchaseInput } from "@/lib/validation";
import { receivePurchase } from "@/server/actions/purchases";
import type { IngredientOption } from "@/server/queries/ingredients";
import type { SupplierProductOption } from "@/server/queries/suppliers";

type FormInput = z.input<typeof purchaseInput>;

export function PurchaseInvoiceBuilder({
  locations,
  suppliers,
  ingredients,
  products,
  units,
  currency,
  defaultSupplierId,
}: {
  locations: { id: string; name: string }[];
  suppliers: { id: string; name: string }[];
  ingredients: IngredientOption[];
  products: SupplierProductOption[];
  units: UnitRow[];
  currency: string;
  defaultSupplierId?: string;
}) {
  const router = useRouter();
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, PurchaseInput>({
    resolver: zodResolver(purchaseInput),
    defaultValues: {
      supplierId: defaultSupplierId ?? "",
      locationId: locations[0]?.id ?? "",
      invoiceNumber: "",
      notes: "",
      items: [{ ingredientId: "", quantity: 1, unitCode: "", unitCost: 0 }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "items" });
  const items = watch("items");
  const selectedSupplierId = watch("supplierId");

  // Only show products that belong to the chosen supplier so prices prefill.
  const supplierProducts = useMemo(() => products.filter(product => product.supplierId === selectedSupplierId), [products, selectedSupplierId]);

  // Track which ingredients are already on the invoice to prevent duplicates.
  const usedIds = new Set((items ?? []).map(item => item.ingredientId).filter(Boolean));

  const invoiceTotal = (items ?? []).reduce((total, item) => {
    const q = Number(item.quantity) || 0;
    const price = Number(item.unitCost) || 0;
    return total + q * price;
  }, 0);

  async function submit(values: PurchaseInput) {
    const result = await receivePurchase(values);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) setError(field as keyof FormInput, { message });
      if (!result.fieldErrors) setError("root", { message: result.error });
      return;
    }
    toast.success("Invoice received — stock and costs updated");
    router.push(`/dashboard/purchases/${result.data.id}`);
    router.refresh();
  }

  function onSupplierChange(supplierId: string) {
    setValue("supplierId", supplierId, { shouldValidate: true });
    // Pre-select the first matching supplier product for each line that has a
    // blank ingredient so the price prefills.
    if (supplierId) {
      const snapshot = items ?? [];
      const prods = products.filter(product => product.supplierId === supplierId);
      snapshot.forEach((item, index) => {
        if (item.ingredientId) return;
        const match = prods.find(product => !usedIds.has(product.ingredientId));
        if (match) {
          setValue(`items.${index}.ingredientId`, match.ingredientId, { shouldValidate: true });
          setValue(`items.${index}.unitCode`, match.packUnitCode ?? "", { shouldValidate: true });
          setValue(`items.${index}.quantity`, match.packQuantity, { shouldValidate: true });
          setValue(`items.${index}.unitCost`, toMajorUnits(match.lastPriceMillis, currency), { shouldValidate: true });
          usedIds.add(match.ingredientId);
        }
      });
    }
  }

  function autofillLine(index: number, ingredientId: string) {
    if (!ingredientId) return;
    const product = supplierProducts.find(product => product.ingredientId === ingredientId);
    const ingredient = ingredients.find(ingredient => ingredient.id === ingredientId);
    if (product) {
      setValue(`items.${index}.unitCode`, product.packUnitCode ?? ingredient?.baseUnitCode ?? "", { shouldValidate: true });
      setValue(`items.${index}.quantity`, product.packQuantity, { shouldValidate: true });
      if (product.lastPriceMillis > 0) setValue(`items.${index}.unitCost`, toMajorUnits(product.lastPriceMillis, currency), { shouldValidate: true });
    } else if (ingredient) {
      setValue(`items.${index}.unitCode`, ingredient.baseUnitCode, { shouldValidate: true });
    }
  }

  const lineOptions = (index: number) => {
    const item = items?.[index];
    const ingredient = ingredients.find(ingredient => ingredient.id === item?.ingredientId);
    if (!ingredient) return units;
    return compatibleUnits(units, ingredient.baseUnitCode);
  };

  return (
    <form onSubmit={handleSubmit(submit)} className="w-full space-y-5">
      {/* ---- header ---- */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(15rem,1.2fr)_minmax(13rem,1fr)_minmax(13rem,1fr)_minmax(11rem,.8fr)]">
        <Field label="Supplier" error={errors.supplierId?.message}>
          <div className="relative">
            <Truck size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
            <Select
              {...register("supplierId", { onChange: event => onSupplierChange(event.target.value) })}
              className="pl-9"
            >
              <option value="">No supplier (manual)</option>
              {suppliers.map(supplier => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </Select>
          </div>
        </Field>

        <Field label="Location" required error={errors.locationId?.message}>
          <div className="relative">
            <MapPin size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
            <Select {...register("locationId")} className="pl-9">
              {locations.map(location => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </Select>
          </div>
        </Field>

        <Field label="Invoice number" error={errors.invoiceNumber?.message}>
          <div className="relative">
            <FileText size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
            <Input {...register("invoiceNumber")} placeholder="e.g. INV-2026-042" className="pl-9" />
          </div>
        </Field>

        <Field label="Date">
          <div className="relative">
            <CalendarDays size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
            <Input {...register("receivedAt")} type="date" className="pl-9" />
          </div>
        </Field>
      </div>

      {/* ---- line items ---- */}
      <div className="overflow-hidden rounded-lg border bg-white">
        <div className="border-b px-5 py-4">
          <h2 className="font-black">Invoice lines</h2>
          <p className="text-sm text-[var(--muted)]">Each line creates one stock movement and updates the ingredient&apos;s latest cost.</p>
        </div>
        <div className="divide-y">
          {fields.map((field, index) => {
            const item = items?.[index];
            const itemErrors = errors.items?.[index] ?? ({} as Record<string, { message?: string }>);
            return (
              <div key={field.id} className="grid gap-3 p-4 xl:grid-cols-[minmax(18rem,1.6fr)_minmax(6.5rem,.45fr)_minmax(6.5rem,.45fr)_minmax(8.5rem,.6fr)_minmax(9rem,.55fr)] xl:items-end 2xl:grid-cols-[minmax(22rem,1.8fr)_minmax(7rem,.42fr)_minmax(7rem,.42fr)_minmax(9rem,.55fr)_minmax(10rem,.55fr)]">
                <Field label="Ingredient" required error={itemErrors.ingredientId?.message}>
                  <Select
                    {...register(`items.${index}.ingredientId`, {
                      onChange: event => autofillLine(index, event.target.value),
                    })}
                  >
                    <option value="">Select ingredient…</option>
                    {ingredients.map(ingredient => (
                      <option key={ingredient.id} value={ingredient.id} disabled={usedIds.has(ingredient.id) && item?.ingredientId !== ingredient.id}>
                        {ingredient.name} ({ingredient.baseUnitCode})
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="Qty" required error={itemErrors.quantity?.message}>
                  <Input type="number" step="0.001" min="0" className="w-full text-right" {...register(`items.${index}.quantity`)} />
                </Field>

                <Field label="Unit" required error={itemErrors.unitCode?.message}>
                  <Select {...register(`items.${index}.unitCode`)} className="w-full">
                    {lineOptions(index).map(unit => (
                      <option key={unit.code} value={unit.code}>
                        {unit.code}
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label={`Cost/${item?.unitCode || "unit"} (${currency})`} required error={itemErrors.unitCost?.message}>
                  <Input type="number" step={moneyInputStep(currency)} min="0" className="w-full text-right" {...register(`items.${index}.unitCost`)} />
                </Field>

                <div className="flex items-end justify-end gap-2">
                  <span className="mb-0.5 whitespace-nowrap text-right text-sm tabular-nums font-semibold text-[var(--muted)]">
                    = {currency} {((Number(item?.quantity ?? 0) * Number(item?.unitCost ?? 0))).toFixed(currency === "TND" ? 3 : 2)}
                  </span>
                  {fields.length > 1 && (
                    <button type="button" aria-label={`Remove line ${index + 1}`} onClick={() => remove(index)} className="mb-0.5 rounded-lg p-1.5 text-red-600 transition hover:bg-red-50">
                      <Minus size={16} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              const firstAvailable = supplierProducts.find(product => !usedIds.has(product.ingredientId));
              append({
                ingredientId: firstAvailable?.ingredientId ?? "",
                quantity: firstAvailable?.packQuantity ?? 1,
                unitCode: firstAvailable?.packUnitCode ?? "",
                unitCost: firstAvailable && firstAvailable.lastPriceMillis > 0 ? toMajorUnits(firstAvailable.lastPriceMillis, currency) : 0,
              });
            }}
          >
            <Plus size={16} /> Add line
          </Button>
          <div className="flex items-center gap-4">
            <span className="text-sm text-[var(--muted)]">Invoice total:</span>
            <b className="text-xl tabular-nums">
              {currency} {invoiceTotal.toFixed(currency === "TND" ? 3 : 2)}
            </b>
          </div>
        </div>
      </div>

      <div className="max-w-3xl">
        <Field label="Notes" error={errors.notes?.message} hint="Delivery slip reference, payment terms, anything worth remembering.">
          <Input {...register("notes")} placeholder="Optional" />
        </Field>
      </div>

      {errors.root && <FormError message={errors.root.message} />}
      {errors.items && typeof errors.items.message === "string" && <FormError message={errors.items.message} />}

      <Button className="w-full md:w-auto md:min-w-80" size="lg" disabled={isSubmitting}>
        {isSubmitting ? (
          "Recording invoice…"
        ) : (
          <>
            <PackagePlus size={18} /> Receive invoice & update stock
          </>
        )}
      </Button>
    </form>
  );
}
