"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Plus, Send, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, FormError } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatMoney } from "@/lib/money";
import { compatibleUnits, toBaseQuantity, type UnitRow } from "@/lib/units";
import { createTransfer } from "@/server/actions/transfers";
import type { LocationOption } from "@/server/queries/locations";

/**
 * Building a transfer: From → To → ingredients → review → send.
 *
 * The availability figures shown here are the source location's real ledger
 * balances, passed in from the server. They are a *warning*, not the check: the
 * server re-reads availability inside the transaction that writes the movements,
 * so a colleague who empties the shelf between page load and submit is caught
 * there rather than here.
 *
 * Quantities may be entered in any unit compatible with the ingredient, and the
 * running conversion below uses the same `toBaseQuantity` the server does — so
 * what the screen shows and what the ledger records cannot disagree.
 */

type IngredientOption = {
  id: string;
  name: string;
  baseUnitCode: string;
  unitCostMillis: number;
  /** On hand at the currently selected source, in base units. */
  stock: number;
};

type DraftLine = { key: number; ingredientId: string; quantity: string; unitCode: string };

export function TransferBuilder({
  locations,
  ingredients,
  units,
  currency,
  defaultSourceId,
}: {
  locations: LocationOption[];
  ingredients: IngredientOption[];
  units: UnitRow[];
  currency: string;
  defaultSourceId?: string;
}) {
  const router = useRouter();
  const [sourceId, setSourceId] = useState(defaultSourceId ?? locations[0]?.id ?? "");
  const [destinationId, setDestinationId] = useState(
    locations.find(option => option.id !== (defaultSourceId ?? locations[0]?.id))?.id ?? "",
  );
  const [lines, setLines] = useState<DraftLine[]>([{ key: 0, ingredientId: "", quantity: "", unitCode: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const byId = useMemo(() => new Map(ingredients.map(item => [item.id, item])), [ingredients]);

  /** Lines with their conversion and availability resolved, for the review panel. */
  const resolved = lines.map(line => {
    const ingredient = byId.get(line.ingredientId);
    const quantity = Number(line.quantity);
    const valid = Boolean(ingredient) && Number.isFinite(quantity) && quantity > 0;
    const unitCode = line.unitCode || ingredient?.baseUnitCode || "";
    const baseQuantity = ingredient && valid ? toBaseQuantity(quantity, unitCode, ingredient.baseUnitCode, units) : 0;

    return {
      ...line,
      ingredient,
      valid,
      unitCode,
      baseQuantity,
      // The client-side warning. The server enforces the same rule for real.
      short: Boolean(ingredient) && valid && baseQuantity > (ingredient?.stock ?? 0) + 1e-6,
      valueMillis: ingredient ? Math.round(baseQuantity * ingredient.unitCostMillis) : 0,
    };
  });

  const usable = resolved.filter(line => line.valid);
  const anyShort = usable.some(line => line.short);
  const totalValue = usable.reduce((total, line) => total + line.valueMillis, 0);
  const sameLocation = Boolean(sourceId) && sourceId === destinationId;

  const duplicateIds = new Set(
    usable.map(line => line.ingredientId).filter((id, index, all) => all.indexOf(id) !== index),
  );

  const canSubmit = usable.length > 0 && !sameLocation && !duplicateIds.size && Boolean(destinationId);

  const submit = (sendNow: boolean) => {
    setError(null);

    if (!canSubmit) {
      setError(
        sameLocation
          ? "Choose a different destination."
          : duplicateIds.size
            ? "The same ingredient appears more than once."
            : "Add at least one ingredient with a quantity.",
      );
      return;
    }

    startTransition(async () => {
      const result = await createTransfer({
        sourceLocationId: sourceId,
        destinationLocationId: destinationId,
        reference: referenceValue,
        note: noteValue,
        sendNow,
        items: usable.map(line => ({
          ingredientId: line.ingredientId,
          quantity: Number(line.quantity),
          unitCode: line.unitCode,
        })),
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      toast.success(sendNow ? "Transfer sent. The stock has left the source." : "Draft transfer saved.");
      router.push(`/dashboard/transfers/${result.data.id}`);
      router.refresh();
    });
  };

  const [referenceValue, setReferenceValue] = useState("");
  const [noteValue, setNoteValue] = useState("");

  const addLine = () =>
    setLines(current => [...current, { key: Math.max(...current.map(line => line.key)) + 1, ingredientId: "", quantity: "", unitCode: "" }]);

  return (
    <div className="space-y-5">
      {/* ------------------------------------------------------- from → to */}
      <Card>
        <CardHeader className="border-b">
          <h2 className="text-lg font-black">Where is the stock going?</h2>
          <p className="text-sm text-[var(--muted)]">
            Stock leaves the source when you send, and arrives at the destination when someone there confirms it.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid items-end gap-4 sm:grid-cols-[1fr_auto_1fr]">
            <Field label="From" required>
              <Select value={sourceId} onChange={event => setSourceId(event.target.value)}>
                {locations.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </Field>

            <span className="hidden pb-3 text-[var(--muted)] sm:block">
              <ArrowRight size={20} />
            </span>

            <Field label="To" required error={sameLocation ? "Pick a different location" : undefined}>
              <Select value={destinationId} onChange={event => setDestinationId(event.target.value)}>
                <option value="">Select a destination…</option>
                {locations
                  .filter(option => option.id !== sourceId)
                  .map(option => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Reference" hint="Your own document number, if you use one.">
              <Input value={referenceValue} onChange={event => setReferenceValue(event.target.value)} placeholder="e.g. TR-1042" />
            </Field>
            <Field label="Note">
              <Input value={noteValue} onChange={event => setNoteValue(event.target.value)} placeholder="Anything the other site should know" />
            </Field>
          </div>
        </CardContent>
      </Card>

      {/* -------------------------------------------------------- the lines */}
      <Card>
        <CardHeader className="border-b">
          <h2 className="text-lg font-black">What is moving?</h2>
          <p className="text-sm text-[var(--muted)]">
            Quantities can be entered in any compatible unit — the ledger records the ingredient&apos;s base unit.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {resolved.map((line, index) => {
            const options = line.ingredient ? compatibleUnits(units, line.ingredient.baseUnitCode) : units;
            return (
              <div key={line.key} className="space-y-1">
                <div className="grid gap-2 sm:grid-cols-[1fr_7rem_7rem_auto] sm:items-end">
                  <span className="flex-1">
                    <Select
                      aria-label={`Ingredient ${index + 1}`}
                      value={line.ingredientId}
                      onChange={event =>
                        setLines(current =>
                          current.map(entry =>
                            entry.key === line.key
                              ? { ...entry, ingredientId: event.target.value, unitCode: byId.get(event.target.value)?.baseUnitCode ?? "" }
                              : entry,
                          ),
                        )
                      }
                    >
                      <option value="">Select an ingredient…</option>
                      {ingredients.map(item => (
                        <option key={item.id} value={item.id}>
                          {item.name} — {item.stock.toLocaleString(undefined, { maximumFractionDigits: 3 })} {item.baseUnitCode} available
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
                    className="h-10 w-full text-right"
                    placeholder="0"
                    value={line.quantity}
                    onChange={event =>
                      setLines(current => current.map(entry => (entry.key === line.key ? { ...entry, quantity: event.target.value } : entry)))
                    }
                  />

                  <span className="shrink-0">
                    <Select
                      aria-label={`Unit ${index + 1}`}
                      value={line.unitCode}
                      disabled={!line.ingredient}
                      onChange={event =>
                        setLines(current => current.map(entry => (entry.key === line.key ? { ...entry, unitCode: event.target.value } : entry)))
                      }
                    >
                      {options.map(unit => (
                        <option key={unit.code} value={unit.code}>
                          {unit.code}
                        </option>
                      ))}
                    </Select>
                  </span>

                  <Button
                    type="button"
                    variant="secondary"
                    className="h-10 shrink-0 px-3"
                    aria-label={`Remove line ${index + 1}`}
                    disabled={lines.length === 1}
                    onClick={() => setLines(current => current.filter(entry => entry.key !== line.key))}
                  >
                    <X size={16} />
                  </Button>
                </div>

                {line.ingredient && line.valid && (
                  <p className={`pl-1 text-xs ${line.short ? "font-semibold text-red-600" : "text-[var(--muted)]"}`}>
                    {line.short
                      ? `Only ${line.ingredient.stock.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${line.ingredient.baseUnitCode} available — this transfer cannot be sent.`
                      : `Moves ${line.baseQuantity.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${line.ingredient.baseUnitCode} · ${formatMoney(line.valueMillis, currency)}`}
                  </p>
                )}
                {line.ingredient && duplicateIds.has(line.ingredientId) && (
                  <p className="pl-1 text-xs font-semibold text-red-600">This ingredient is already on the transfer.</p>
                )}
              </div>
            );
          })}

          <Button type="button" variant="secondary" onClick={addLine}>
            <Plus size={15} /> Add ingredient
          </Button>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------ review + send */}
      <Card>
        <CardContent className="pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-neutral-50 px-4 py-3">
            <span className="text-sm font-semibold">
              {usable.length} ingredient{usable.length === 1 ? "" : "s"} moving
            </span>
            <b className="text-lg tabular-nums">{formatMoney(totalValue, currency)}</b>
          </div>

          {anyShort && (
            <p className="mt-3 rounded-lg bg-red-50 p-3 text-sm font-semibold text-red-700">
              Some lines ask for more than the source location holds. Reduce them, or save a draft and send once stock arrives.
            </p>
          )}

          <FormError message={error} className="mt-3" />

          <div className="mt-4 grid gap-2 sm:flex sm:flex-wrap">
            <Button onClick={() => submit(true)} disabled={pending || !canSubmit || anyShort}>
              {pending ? "Working…" : (<><Send size={16} /> Send now</>)}
            </Button>
            <Button variant="secondary" onClick={() => submit(false)} disabled={pending || !canSubmit}>
              Save as draft
            </Button>
          </div>
          <p className="mt-3 text-xs text-[var(--muted)]">
            Sending deducts the stock from the source immediately. It arrives at the destination only when someone there
            confirms receipt — until then it is shown as in transit.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
