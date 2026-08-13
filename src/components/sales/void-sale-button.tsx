"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Ban } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { voidSale } from "@/server/actions/sales";

/**
 * Voids a sale.
 *
 * A reason is required: a revenue figure that changed without an explanation is
 * worse than one that never changed. The sale is kept and flagged rather than
 * deleted, so the correction stays auditable.
 */
export function VoidSaleButton({ saleId }: { saleId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await voidSale({ saleId, reason: String(formData.get("reason") ?? "") });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast.success("Sale voided. It no longer counts towards revenue.");
      router.refresh();
    });
  };

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Ban size={16} /> Void sale
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Void this sale">
        <form action={submit} className="space-y-4">
          <p className="text-sm text-[var(--muted)]">
            The sale stays on record but stops counting towards revenue, units sold and theoretical consumption. Sale
            lines cannot be edited — to correct a mistake, void this and record the sale again.
          </p>

          <Field label="Reason" required>
            <Input name="reason" required autoFocus placeholder="e.g. Entered twice by mistake" />
          </Field>

          <FormError message={error} />

          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" className="flex-1" disabled={pending}>
              {pending ? "Voiding…" : "Void sale"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
