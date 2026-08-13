"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ClipboardList, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { createStockCount } from "@/server/actions/stock-counts";
import type { LocationOption } from "@/server/queries/locations";

/**
 * Opens a new count sheet.
 *
 * The scope picker only decides *which ingredients appear* on the sheet. The
 * system quantity for each of them is read from the ledger on the server — it
 * is never sent from here, because a count that let you type what the system
 * "should" hold would measure nothing.
 */
export function NewCountButton({ locations, categories }: { locations: LocationOption[]; categories: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"all" | "category" | "low_stock">("all");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await createStockCount({
        locationId: String(formData.get("locationId") ?? ""),
        reference: String(formData.get("reference") ?? ""),
        note: String(formData.get("note") ?? ""),
        scope: String(formData.get("scope") ?? "all"),
        category: String(formData.get("category") ?? ""),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.push(`/dashboard/inventory/counts/${result.data.id}`);
    });
  };

  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={locations.length === 0}>
        <Plus size={16} /> New count
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Start a stock count">
        <form action={submit} className="space-y-4">
          <Field label="Location" required hint="Stock is counted one location at a time.">
            <Select name="locationId" required defaultValue={locations[0]?.id}>
              {locations.map(location => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Reference" hint="Optional label, e.g. “Week 32 full count”.">
            <Input name="reference" placeholder="Week 32 full count" />
          </Field>

          <Field label="What to count" required>
            <Select name="scope" value={scope} onChange={event => setScope(event.currentTarget.value as typeof scope)}>
              <option value="all">All active ingredients</option>
              <option value="category">One category</option>
              <option value="low_stock">Low and out-of-stock only</option>
            </Select>
          </Field>

          {scope === "category" && (
            <Field label="Category" required>
              <Select name="category" required defaultValue={categories[0] ?? ""}>
                {categories.map(category => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label="Note">
            <Input name="note" placeholder="Anything the approver should know" />
          </Field>

          <FormError message={error} />

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Opening count sheet…" : <><ClipboardList size={16} /> Open count sheet</>}
          </Button>
        </form>
      </Modal>
    </>
  );
}
