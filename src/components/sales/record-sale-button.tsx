"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { Plus, Receipt, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { formatMoney } from "@/lib/money";
import { recordSale } from "@/server/actions/sales";
import type { LocationOption } from "@/server/queries/locations";

type MenuOption = { id: string; name: string; sellingPriceMillis: number };
type DraftLine = { key: number; menuItemId: string; quantity: string };

/**
 * Records a sale.
 *
 * Prices are shown here but never submitted: the form sends menu item ids and
 * quantities, and the server resolves the price from its own catalog. The
 * running total is a preview of what the server will compute, not an input to
 * it — a tampered request cannot invent revenue.
 */
export function RecordSaleButton({
  locations,
  menuItems,
  currency,
  defaultLocationId,
}: {
  locations: LocationOption[];
  menuItems: MenuOption[];
  currency: string;
  defaultLocationId?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([{ key: 0, menuItemId: "", quantity: "1" }]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const priceById = useMemo(() => new Map(menuItems.map(item => [item.id, item.sellingPriceMillis])), [menuItems]);

  const total = lines.reduce((sum, line) => {
    const price = priceById.get(line.menuItemId) ?? 0;
    const quantity = Number(line.quantity);
    return sum + (Number.isFinite(quantity) && quantity > 0 ? price * quantity : 0);
  }, 0);

  const reset = () => {
    setLines([{ key: 0, menuItemId: "", quantity: "1" }]);
    setError(null);
  };

  const submit = (formData: FormData) => {
    setError(null);
    const items = lines
      .filter(line => line.menuItemId && Number(line.quantity) > 0)
      .map(line => ({ menuItemId: line.menuItemId, quantity: Number(line.quantity) }));

    if (!items.length) {
      setError("Add at least one item with a quantity.");
      return;
    }

    startTransition(async () => {
      const soldAtRaw = String(formData.get("soldAt") ?? "");
      const result = await recordSale({
        locationId: String(formData.get("locationId") ?? ""),
        reference: String(formData.get("reference") ?? ""),
        note: String(formData.get("note") ?? ""),
        source: "manual",
        // `datetime-local` has no zone; interpreting it in the browser's zone is
        // right for someone entering a sale that happened where they are.
        soldAt: soldAtRaw ? new Date(soldAtRaw).toISOString() : undefined,
        items,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setOpen(false);
      reset();
      toast.success(result.data.duplicate ? "That sale was already recorded." : "Sale recorded.");
      router.refresh();
    });
  };

  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={menuItems.length === 0} title={menuItems.length === 0 ? "Create a menu item first" : undefined}>
        <Plus size={16} /> Record sale
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Record a sale" size="lg">
        <form action={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Location" required>
              <Select name="locationId" required defaultValue={defaultLocationId ?? locations[0]?.id}>
                {locations.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Sold at" hint="Leave empty to use now.">
              <Input name="soldAt" type="datetime-local" />
            </Field>
          </div>

          <Field label="Reference" hint="Ticket or receipt number, if you have one.">
            <Input name="reference" placeholder="e.g. T-1042" />
          </Field>

          <div className="space-y-2">
            <p className="text-sm font-bold">Items sold</p>
            {lines.map((line, index) => (
              <div key={line.key} className="flex items-end gap-2">
                <span className="flex-1">
                  <Select
                    aria-label={`Menu item ${index + 1}`}
                    value={line.menuItemId}
                    onChange={event =>
                      setLines(current => current.map(entry => (entry.key === line.key ? { ...entry, menuItemId: event.target.value } : entry)))
                    }
                  >
                    <option value="">Select an item…</option>
                    {menuItems.map(item => (
                      <option key={item.id} value={item.id}>
                        {item.name} — {formatMoney(item.sellingPriceMillis, currency)}
                      </option>
                    ))}
                  </Select>
                </span>
                <Input
                  aria-label={`Quantity ${index + 1}`}
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  className="h-11 w-24 text-right"
                  value={line.quantity}
                  onChange={event =>
                    setLines(current => current.map(entry => (entry.key === line.key ? { ...entry, quantity: event.target.value } : entry)))
                  }
                />
                <Button
                  type="button"
                  variant="secondary"
                  className="h-11 shrink-0 px-3"
                  aria-label={`Remove item ${index + 1}`}
                  disabled={lines.length === 1}
                  onClick={() => setLines(current => current.filter(entry => entry.key !== line.key))}
                >
                  <X size={16} />
                </Button>
              </div>
            ))}

            <Button
              type="button"
              variant="secondary"
              onClick={() => setLines(current => [...current, { key: Math.max(...current.map(entry => entry.key)) + 1, menuItemId: "", quantity: "1" }])}
            >
              <Plus size={15} /> Add item
            </Button>
          </div>

          <Field label="Note">
            <Input name="note" placeholder="Anything worth remembering about this sale" />
          </Field>

          <div className="flex items-center justify-between rounded-xl border bg-neutral-50 px-4 py-3">
            <span className="text-sm font-semibold">Total</span>
            <b className="text-lg tabular-nums">{formatMoney(total, currency)}</b>
          </div>
          <p className="text-xs text-[var(--muted)]">
            Prices are taken from the menu on the server as the sale is saved, and stored with it — a later price change
            will not alter this sale.
          </p>

          <FormError message={error} />

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? "Recording…" : <><Receipt size={16} /> Record sale</>}
          </Button>
        </form>
      </Modal>
    </>
  );
}
