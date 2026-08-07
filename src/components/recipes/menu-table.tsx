"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Plus, Trash2, UtensilsCrossed } from "lucide-react";
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
import { deleteMenuItem, setMenuItemArchived } from "@/server/actions/recipes";
import type { MenuItemRow } from "@/server/queries/menu";

export function MenuTable({
  rows,
  recipes,
  currency,
  canManage,
  isEmptyMenu,
}: {
  rows: MenuItemRow[];
  recipes: { id: string; name: string }[];
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
    <Modal open={creating} onClose={() => setCreating(false)} title="New menu item" description="Link a recipe to see real food cost and margin instead of a guess." size="lg">
      <MenuItemForm recipes={recipes} currency={currency} onSaved={() => setCreating(false)} onCancel={() => setCreating(false)} />
    </Modal>
  );

  if (isEmptyMenu) {
    return (
      <>
        <Card>
          <EmptyState
            icon={UtensilsCrossed}
            title="No menu items yet"
            description="Add what you sell and link it to a recipe. You will immediately see food cost percentage, gross profit and margin calculated from real ingredient prices."
            action={canManage ? <Button onClick={() => setCreating(true)}><Plus size={17} /> Add menu item</Button> : undefined}
            secondaryAction={recipes.length === 0 ? { label: "Build a recipe first", href: "/dashboard/recipes" } : undefined}
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
              <TH>Recipe</TH>
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
                    {row.recipeName ? (
                      <Link href="/dashboard/recipes" className="text-sm font-semibold text-green-800 hover:underline">
                        {row.recipeName}
                      </Link>
                    ) : (
                      <Badge tone="warning">No recipe</Badge>
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

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={`Edit ${editing?.name ?? ""}`} size="lg">
        {editing && (
          <MenuItemForm
            recipes={recipes}
            currency={currency}
            submitLabel="Save changes"
            defaultValues={{
              id: editing.id,
              name: editing.name,
              category: editing.category ?? "",
              recipeId: editing.recipeId ?? "",
              sellingPrice: toMajorUnits(editing.sellingPriceMillis, currency),
              packagingCost: toMajorUnits(editing.packagingCostMillis, currency),
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
