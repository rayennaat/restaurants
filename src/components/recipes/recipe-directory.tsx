"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, ArchiveRestore, ChefHat, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { RecipeForm } from "@/components/forms/recipe-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { Modal } from "@/components/ui/modal";
import { foodCostTone } from "@/lib/costing";
import { formatMoney, formatPercent } from "@/lib/money";
import { formatQuantity, type UnitRow } from "@/lib/units";
import { deleteRecipe, setRecipeArchived } from "@/server/actions/recipes";
import type { IngredientOption } from "@/server/queries/ingredients";
import type { RecipeWithCosting } from "@/server/queries/recipes";

export function RecipeDirectory({
  recipes,
  ingredients,
  units,
  currency,
  canManage,
  isEmptyDirectory,
}: {
  recipes: RecipeWithCosting[];
  ingredients: IngredientOption[];
  units: UnitRow[];
  currency: string;
  canManage: boolean;
  isEmptyDirectory: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RecipeWithCosting | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
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
    <Modal open={creating} onClose={() => setCreating(false)} title="New recipe" description="Add ingredients and quantities — the cost calculates itself from live ingredient prices." size="xl">
      <RecipeForm ingredients={ingredients} units={units} onSuccess={() => setCreating(false)} />
    </Modal>
  );

  if (isEmptyDirectory) {
    return (
      <>
        <Card>
          <EmptyState
            icon={ChefHat}
            title="No recipes yet"
            description="A recipe turns ingredient quantities into a real cost per serving. Once you have one, you can attach a menu price and see your true food cost percentage and margin."
            action={canManage ? <Button onClick={() => setCreating(true)}><Plus size={17} /> Build your first recipe</Button> : undefined}
            secondaryAction={ingredients.length === 0 ? { label: "Add ingredients first", href: "/dashboard/ingredients" } : undefined}
          />
        </Card>
        {createModal}
      </>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar
          searchPlaceholder="Search recipes…"
          filters={[
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
          ]}
          className="flex-1"
        />
        {canManage && (
          <Button onClick={() => setCreating(true)}>
            <Plus size={17} /> New recipe
          </Button>
        )}
      </div>

      {recipes.length === 0 ? (
        <Card>
          <EmptyState icon={ChefHat} title="No recipes match these filters" description="Try clearing the search box or switching the status filter." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {recipes.map(recipe => {
            const { costing } = recipe;
            const primaryMenuItem = recipe.menuItems[0];
            const isOpen = expanded === recipe.id;

            return (
              <Card key={recipe.id} className="relative flex flex-col">
                <CardContent className="flex flex-1 flex-col pt-5">
                  <div className="flex items-start justify-between gap-2">
                    <button type="button" onClick={() => setExpanded(isOpen ? null : recipe.id)} className="min-w-0 flex-1 text-left">
                      <h2 className="truncate font-black hover:text-green-800">{recipe.name}</h2>
                      <p className="mt-0.5 text-sm text-[var(--muted)]">
                        {recipe.lines.length} ingredient{recipe.lines.length === 1 ? "" : "s"} · yields {formatQuantity(recipe.yieldQuantity, recipe.yieldUnitCode ?? "portion")}
                      </p>
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      {!recipe.isActive && <Badge>Archived</Badge>}
                      {canManage && (
                        <button type="button" aria-label={`Actions for ${recipe.name}`} onClick={() => setMenuFor(menuFor === recipe.id ? null : recipe.id)} className="rounded-lg p-1.5 text-[var(--muted)] transition hover:bg-neutral-100">
                          <MoreHorizontal size={18} />
                        </button>
                      )}
                    </div>
                  </div>

                  {menuFor === recipe.id && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} />
                      <div className="absolute right-4 top-14 z-20 w-52 overflow-hidden rounded-xl border bg-white py-1 shadow-xl">
                        <button type="button" onClick={() => { setMenuFor(null); setEditing(recipe); }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold hover:bg-neutral-50">
                          <Pencil size={15} /> Edit recipe
                        </button>
                        <button
                          type="button"
                          onClick={() => runAction(setRecipeArchived(recipe.id, recipe.isActive), recipe.isActive ? "Recipe archived" : "Recipe restored")}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold hover:bg-neutral-50"
                        >
                          {recipe.isActive ? <><Archive size={15} /> Archive</> : <><ArchiveRestore size={15} /> Restore</>}
                        </button>
                        <button
                          type="button"
                          onClick={() => { if (confirm(`Permanently delete “${recipe.name}”?`)) runAction(deleteRecipe(recipe.id), "Recipe deleted"); }}
                          className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold text-red-700 hover:bg-red-50"
                        >
                          <Trash2 size={15} /> Delete
                        </button>
                      </div>
                    </>
                  )}

                  <div className="mt-5 grid grid-cols-2 gap-3">
                    <div className="rounded-xl bg-neutral-50 p-3">
                      <p className="text-xs text-[var(--muted)]">Batch cost</p>
                      <b className="tabular-nums">{formatMoney(costing.totalCostMillis, currency)}</b>
                    </div>
                    <div className="rounded-xl bg-neutral-50 p-3">
                      <p className="text-xs text-[var(--muted)]">Per serving</p>
                      <b className="tabular-nums">{formatMoney(costing.costPerServingMillis, currency)}</b>
                    </div>
                  </div>

                  {primaryMenuItem ? (
                    <div className="mt-3 rounded-xl bg-green-50 p-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-semibold text-green-800">{primaryMenuItem.name}</p>
                        <Badge tone={foodCostTone(primaryMenuItem.economics.foodCostPercent)}>{formatPercent(primaryMenuItem.economics.foodCostPercent)} food cost</Badge>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                        <span className="text-[var(--muted)]">
                          Price <b className="block tabular-nums text-[var(--foreground)]">{formatMoney(primaryMenuItem.sellingPriceMillis, currency)}</b>
                        </span>
                        <span className="text-[var(--muted)]">
                          Profit <b className="block tabular-nums text-green-800">{formatMoney(primaryMenuItem.economics.grossProfitMillis, currency)}</b>
                        </span>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-900">
                      No menu item linked — add one to see food cost % and margin.
                    </p>
                  )}

                  {costing.hasUncostedIngredient && (
                    <p className="mt-3 text-xs font-semibold text-amber-700">Some ingredients have no cost yet, so this total is understated.</p>
                  )}

                  {isOpen && costing.lines.length > 0 && (
                    <ul className="mt-4 space-y-1.5 border-t pt-3">
                      {costing.lines.map(line => (
                        <li key={line.ingredientId} className="flex items-baseline justify-between gap-2 text-xs">
                          <span className="min-w-0 truncate">
                            {line.ingredientName} <span className="text-[var(--muted)]">{formatQuantity(line.quantity, line.unitCode ?? line.baseUnitCode)}</span>
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {formatMoney(line.lineCostMillis, currency)} <span className="text-[var(--muted)]">{line.sharePercent.toFixed(0)}%</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {createModal}

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={`Edit ${editing?.name ?? ""}`} size="xl">
        {editing && <RecipeForm recipe={editing} ingredients={ingredients} units={units} onSuccess={() => setEditing(null)} />}
      </Modal>
    </div>
  );
}
