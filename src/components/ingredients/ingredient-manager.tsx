"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Archive, ArchiveRestore, Boxes, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { IngredientForm } from "@/components/forms/ingredient-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { Modal } from "@/components/ui/modal";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { formatMoney, toMajorUnits } from "@/lib/money";
import { formatQuantity, type UnitRow } from "@/lib/units";
import { deleteIngredient, setIngredientArchived } from "@/server/actions/ingredients";
import type { IngredientRow } from "@/server/queries/ingredients";

type Props = {
  rows: IngredientRow[];
  units: UnitRow[];
  categories: string[];
  currency: string;
  canManage: boolean;
  /** True when the org has no ingredients at all, as opposed to none matching the filters. */
  isEmptyCatalog: boolean;
};

export function IngredientManager({ rows, units, categories, currency, canManage, isEmptyCatalog }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState<IngredientRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const filters = useMemo(
    () => [
      {
        name: "status",
        label: "Status",
        defaultValue: "active",
        options: [
          { value: "active", label: "Active" },
          { value: "archived", label: "Archived" },
          { value: "all", label: "All statuses" },
        ],
      },
      {
        name: "stock",
        label: "Stock level",
        defaultValue: "all",
        options: [
          { value: "all", label: "Any stock" },
          { value: "low", label: "Below minimum" },
          { value: "out", label: "Out of stock" },
        ],
      },
      ...(categories.length
        ? [{ name: "category", label: "Category", defaultValue: "", options: [{ value: "", label: "All categories" }, ...categories.map(c => ({ value: c, label: c }))] }]
        : []),
      {
        name: "sort",
        label: "Sort",
        defaultValue: "name",
        options: [
          { value: "name", label: "Name A–Z" },
          { value: "cost", label: "Most expensive" },
          { value: "stock", label: "Lowest stock" },
          { value: "updated", label: "Recently updated" },
        ],
      },
    ],
    [categories],
  );

  function runAction(promise: Promise<{ ok: boolean; error?: string }>, successMessage: string) {
    setMenuFor(null);
    startTransition(async () => {
      const result = await promise;
      if (result.ok) {
        toast.success(successMessage);
        router.refresh();
      } else {
        toast.error(result.error ?? "Action failed");
      }
    });
  }

  if (isEmptyCatalog) {
    return (
      <>
        <div className="rounded-lg border bg-white shadow-sm">
          <EmptyState
            icon={Boxes}
            title="Your ingredient list is empty"
            description="Ingredients are the foundation of everything else — inventory balances, recipe costs and supplier prices all build on them. Add the items you buy most often first."
            action={
              canManage ? (
                <Button onClick={() => setCreating(true)}>
                  <Plus size={17} /> Add your first ingredient
                </Button>
              ) : undefined
            }
          />
        </div>
        <Modal open={creating} onClose={() => setCreating(false)} title="New ingredient" description="Set the base unit you count this item in — everything else converts to it." size="lg">
          <IngredientForm units={units} currency={currency} categories={categories} onSaved={() => setCreating(false)} onCancel={() => setCreating(false)} />
        </Modal>
      </>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar searchPlaceholder="Search name, SKU or category…" filters={filters} className="flex-1" />
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <Plus size={17} /> New ingredient
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-white shadow-sm">
          <EmptyState icon={Boxes} title="No ingredients match these filters" description="Try clearing the search box or switching the status filter back to “All statuses”." />
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-white shadow-sm">
          <Table className="min-w-[860px]">
            <THead>
              <TR className="hover:bg-transparent">
                <TH>Ingredient</TH>
                <TH>Category</TH>
                <TH className="text-right">In stock</TH>
                <TH className="text-right">Minimum</TH>
                <TH className="text-right">Unit cost</TH>
                <TH className="text-right">Stock value</TH>
                <TH>Status</TH>
                <TH className="w-12" />
              </TR>
            </THead>
            <TBody>
              {rows.map(row => {
                const isLow = row.isActive && row.stock < row.minimumStock;
                return (
                  <TR key={row.id}>
                    <TD>
                      <b className="block">{row.name}</b>
                      <span className="text-xs text-[var(--muted)]">
                        {row.sku ? `${row.sku} · ` : ""}
                        {row.supplierCount > 0 ? `${row.supplierCount} supplier${row.supplierCount > 1 ? "s" : ""}` : "No supplier linked"}
                      </span>
                    </TD>
                    <TD className="text-[var(--muted)]">{row.category ?? "—"}</TD>
                    <TDNum className={isLow ? "font-bold text-red-700" : ""}>{formatQuantity(row.stock, row.baseUnitCode)}</TDNum>
                    <TDNum className="text-[var(--muted)]">{formatQuantity(row.minimumStock, row.baseUnitCode)}</TDNum>
                    <TDNum>
                      {formatMoney(row.unitCostMillis, currency)}
                      <span className="text-xs text-[var(--muted)]">/{row.baseUnitCode}</span>
                    </TDNum>
                    <TDNum className="font-semibold">{formatMoney(Math.round(row.stock * row.unitCostMillis), currency)}</TDNum>
                    <TD>
                      {!row.isActive ? <Badge>Archived</Badge> : isLow ? <Badge tone="danger">Low stock</Badge> : <Badge tone="success">Healthy</Badge>}
                    </TD>
                    <TD className="relative">
                      {canManage && (
                        <>
                          <button
                            type="button"
                            aria-label={`Actions for ${row.name}`}
                            onClick={() => setMenuFor(menuFor === row.id ? null : row.id)}
                            className="rounded-lg p-1.5 text-[var(--muted)] transition hover:bg-neutral-100"
                          >
                            <MoreHorizontal size={18} />
                          </button>
                          {menuFor === row.id && (
                            <>
                              <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} />
                              <div className="absolute right-4 top-12 z-20 w-52 overflow-hidden rounded-lg border bg-white py-1 shadow-xl">
                                <button type="button" onClick={() => { setMenuFor(null); setEditing(row); }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold hover:bg-neutral-50">
                                  <Pencil size={15} /> Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => runAction(setIngredientArchived(row.id, row.isActive), row.isActive ? "Ingredient archived" : "Ingredient restored")}
                                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold hover:bg-neutral-50"
                                >
                                  {row.isActive ? <><Archive size={15} /> Archive</> : <><ArchiveRestore size={15} /> Restore</>}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (confirm(`Permanently delete “${row.name}”? This only works if it has no history.`)) {
                                      runAction(deleteIngredient(row.id), "Ingredient deleted");
                                    }
                                  }}
                                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold text-red-700 hover:bg-red-50"
                                >
                                  <Trash2 size={15} /> Delete
                                </button>
                              </div>
                            </>
                          )}
                        </>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </div>
      )}

      <p className="text-sm text-[var(--muted)]">
        Stock balances come from the movement ledger at your active location. Receive a{" "}
        <Link href="/dashboard/purchases?view=new" className="font-semibold text-green-800 underline-offset-2 hover:underline">
          purchase invoice
        </Link>{" "}
        to add stock and refresh unit costs.
      </p>

      <Modal open={creating} onClose={() => setCreating(false)} title="New ingredient" description="Set the base unit you count this item in — everything else converts to it." size="lg">
        <IngredientForm units={units} currency={currency} categories={categories} onSaved={() => setCreating(false)} onCancel={() => setCreating(false)} />
      </Modal>

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={`Edit ${editing?.name ?? ""}`} size="lg">
        {editing && (
          <IngredientForm
            units={units}
            currency={currency}
            categories={categories}
            submitLabel="Save changes"
            defaultValues={{
              id: editing.id,
              name: editing.name,
              sku: editing.sku ?? "",
              category: editing.category ?? "",
              baseUnitCode: editing.baseUnitCode,
              minimumStock: editing.minimumStock,
              unitCost: toMajorUnits(editing.unitCostMillis, currency),
              isActive: editing.isActive,
            }}
            onSaved={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>
    </div>
  );
}
