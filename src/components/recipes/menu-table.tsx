"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Plus, Soup, Trash2, UtensilsCrossed } from "lucide-react";
import { toast } from "sonner";
import { MenuItemForm } from "@/components/forms/menu-item-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal } from "@/components/ui/modal";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "@/components/ui/table";
import { foodCostTone } from "@/lib/costing";
import { formatMoney, formatPercent, toMajorUnits } from "@/lib/money";
import type { UnitRow } from "@/lib/units";
import { deleteMenuItem, setMenuItemArchived } from "@/server/actions/recipes";
import type { PreparationCost } from "@/components/forms/composition-builder";
import type { IngredientOption } from "@/server/queries/ingredients";
import type { MenuItemRow } from "@/server/queries/menu";
import { summarizeLines } from "@/server/queries/recipe-lines";
import type { RecipeOption } from "@/server/queries/recipes";

export function MenuTable({
  rows,
  ingredients,
  preparations,
  preparationCosts,
  units,
  currency,
  canManage,
  isEmptyMenu,
}: {
  rows: MenuItemRow[];
  ingredients: IngredientOption[];
  preparations: RecipeOption[];
  preparationCosts: PreparationCost[];
  units: UnitRow[];
  currency: string;
  canManage: boolean;
  isEmptyMenu: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MenuItemRow | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [, startTransition] = useTransition();

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

  const createModal = (
    <Modal open={creating} onClose={() => setCreating(false)} title="New menu item" description="Add what goes into it and see food cost and margin as you type." size="xl">
      <MenuItemForm
        ingredients={ingredients}
        preparations={preparations}
        preparationCosts={preparationCosts}
        units={units}
        currency={currency}
        onSaved={() => setCreating(false)}
        onCancel={() => setCreating(false)}
      />
    </Modal>
  );

  if (isEmptyMenu) {
    return (
      <>
        <Card>
          <EmptyState
            icon={UtensilsCrossed}
            title="No menu items yet"
            description="Add what you sell and what goes into it. Food cost, gross profit and margin are calculated from real ingredient prices as you type."
            action={canManage ? <Button onClick={() => setCreating(true)}><Plus size={17} /> Add menu item</Button> : undefined}
            secondaryAction={ingredients.length === 0 ? { label: "Add ingredients first", href: "/dashboard/ingredients" } : undefined}
          />
        </Card>
        {createModal}
      </>
    );
  }

  return (
    <div className="space-y-5">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setCreating(true)}>
            <Plus size={17} /> New menu item
          </Button>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border bg-white panel-shadow">
        <Table className="min-w-[900px]">
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Item</TH>
              <TH>Made of</TH>
              <TH className="text-right">Selling price</TH>
              <TH className="text-right">Recipe cost</TH>
              <TH className="text-right">Food cost %</TH>
              <TH className="text-right">Gross profit</TH>
              <TH className="text-right">Margin %</TH>
              <TH className="w-12" />
            </TR>
          </THead>
          <TBody>
            {rows.map(row => {
              const { economics } = row;
              return (
                <TR key={row.id}>
                  <TD>
                    <b>{row.name}</b>
                    {row.category && <span className="block text-xs text-[var(--muted)]">{row.category}</span>}
                  </TD>
                  <TD>
                    {row.lines.length === 0 ? (
                      <Badge tone="warning">Nothing added</Badge>
                    ) : (
                      <span className="flex items-center gap-1.5 text-sm text-[var(--muted)]">
                        {row.lines.some(line => line.kind === "recipe") && <Soup size={13} className="shrink-0 text-amber-700" />}
                        {summarizeLines(row.lines)}
                      </span>
                    )}
                  </TD>
                  <TDNum className="font-semibold">{formatMoney(row.sellingPriceMillis, currency)}</TDNum>
                  <TDNum>
                    {economics.isCosted ? (
                      <>
                        {formatMoney(economics.totalCostMillis, currency)}
                        {row.packagingCostMillis > 0 && <span className="block text-xs text-[var(--muted)]">incl. packaging</span>}
                      </>
                    ) : (
                      <span className="text-[var(--muted)]">—</span>
                    )}
                  </TDNum>
                  <TDNum>{economics.isCosted ? <Badge tone={foodCostTone(economics.foodCostPercent)}>{formatPercent(economics.foodCostPercent)}</Badge> : <span className="text-[var(--muted)]">—</span>}</TDNum>
                  <TDNum className={economics.isCosted && economics.grossProfitMillis < 0 ? "font-semibold text-red-700" : "font-semibold"}>
                    {economics.isCosted ? formatMoney(economics.grossProfitMillis, currency) : <span className="font-normal text-[var(--muted)]">—</span>}
                  </TDNum>
                  <TDNum>{economics.isCosted ? formatPercent(economics.grossMarginPercent) : <span className="text-[var(--muted)]">—</span>}</TDNum>
                  <TD className="relative">
                    {canManage && (
                      <>
                        <button type="button" aria-label={`Actions for ${row.name}`} onClick={() => setMenuFor(menuFor === row.id ? null : row.id)} className="rounded-lg p-1.5 text-[var(--muted)] transition hover:bg-neutral-100">
                          <MoreHorizontal size={18} />
                        </button>
                        {menuFor === row.id && (
                          <>
                            <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} />
                            <div className="absolute right-4 top-12 z-20 w-48 overflow-hidden rounded-xl border bg-white py-1 shadow-xl">
                              <button type="button" onClick={() => { setMenuFor(null); setEditing(row); }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold hover:bg-neutral-50">
                                <Pencil size={15} /> Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => runAction(setMenuItemArchived(row.id, row.isActive), row.isActive ? "Menu item archived" : "Menu item restored")}
                                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold hover:bg-neutral-50"
                              >
                                {row.isActive ? <><Archive size={15} /> Archive</> : <><ArchiveRestore size={15} /> Restore</>}
                              </button>
                              <button
                                type="button"
                                onClick={() => { if (confirm(`Delete “${row.name}”?`)) runAction(deleteMenuItem(row.id), "Menu item deleted"); }}
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

      {createModal}

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={`Edit ${editing?.name ?? ""}`} size="xl">
        {editing && (
          <MenuItemForm
            ingredients={ingredients}
            preparations={preparations}
            preparationCosts={preparationCosts}
            units={units}
            currency={currency}
            submitLabel="Save changes"
            defaultValues={{
              id: editing.id,
              name: editing.name,
              category: editing.category ?? "",
              yieldQuantity: editing.yieldQuantity,
              sellingPrice: toMajorUnits(editing.sellingPriceMillis, currency),
              packagingCost: toMajorUnits(editing.packagingCostMillis, currency),
              isActive: editing.isActive,
              items: editing.lines.map(line => ({
                kind: line.kind,
                ingredientId: line.kind === "ingredient" ? line.targetId : "",
                componentRecipeId: line.kind === "recipe" ? line.targetId : "",
                quantity: line.quantity,
                unitCode: line.unitCode ?? line.baseUnitCode,
              })),
            }}
            onSaved={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        )}
      </Modal>
    </div>
  );
}
