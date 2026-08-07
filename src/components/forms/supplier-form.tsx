"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { supplierInput, type SupplierInput } from "@/lib/validation";
import { saveSupplier } from "@/server/actions/suppliers";

type FormInput = z.input<typeof supplierInput>;

export function SupplierForm({
  defaultValues,
  submitLabel = "Save supplier",
  onSaved,
  onCancel,
}: {
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
  } = useForm<FormInput, unknown, SupplierInput>({
    resolver: zodResolver(supplierInput),
    defaultValues: { name: "", contactName: "", phone: "", email: "", address: "", notes: "", isActive: true, ...defaultValues },
  });

  async function submit(values: SupplierInput) {
    const result = await saveSupplier(values);
    if (!result.ok) {
      for (const [field, message] of Object.entries(result.fieldErrors ?? {})) setError(field as keyof FormInput, { message });
      if (!result.fieldErrors) setError("root", { message: result.error });
      return;
    }
    toast.success(defaultValues?.id ? "Supplier updated" : "Supplier created");
    if (!defaultValues?.id) reset();
    router.refresh();
    onSaved?.(result.data.id);
  }

  return (
    <form onSubmit={handleSubmit(submit)} className="grid gap-4 sm:grid-cols-2">
      {defaultValues?.id && <input type="hidden" {...register("id")} />}

      <Field label="Supplier name" required error={errors.name?.message} className="sm:col-span-2">
        <Input {...register("name")} placeholder="Fresh Foods Tunis" autoFocus={!defaultValues?.id} />
      </Field>

      <Field label="Contact person" error={errors.contactName?.message}>
        <Input {...register("contactName")} placeholder="Optional" />
      </Field>

      <Field label="Phone" error={errors.phone?.message}>
        <Input {...register("phone")} placeholder="+216 71 000 111" inputMode="tel" />
      </Field>

      <Field label="Email" error={errors.email?.message} className="sm:col-span-2">
        <Input {...register("email")} type="email" placeholder="orders@supplier.com" />
      </Field>

      <Field label="Address" error={errors.address?.message} className="sm:col-span-2">
        <Input {...register("address")} placeholder="Optional" />
      </Field>

      <Field label="Notes" error={errors.notes?.message} className="sm:col-span-2" hint="Delivery days, minimum order, payment terms…">
        <Textarea {...register("notes")} placeholder="Delivers Tuesday and Friday. Minimum order 200 TND." />
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
