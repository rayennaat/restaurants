"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Archive, ArchiveRestore, MoreHorizontal, Pencil, Plus, Soup, Trash2, UtensilsCrossed } from "lucide-react";
import { toast } from "sonner";
import { RecipeForm } from "@/components/forms/recipe-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { Modal } from "@/components/ui/modal";
import { formatMoney } from "@/lib/money";
import { formatQuantity, type UnitRow } from "@/lib/units";
import { deleteRecipe, setRecipeArchived } from "@/server/actions/recipes";
import type { IngredientOption } from "@/server/queries/ingredients";
import type { RecipeOption, RecipeWithCosting } from "@/server/queries/recipes";

/**
 * The preparation library: batches made once and consumed by dishes. Dishes are
 * created and priced on the Menu page, so nothing here carries a selling price.
 */
export function RecipeDirectory({
  recipes,
  ingredients,
  recipeOptions,
  units,
  currency,
  canManage,
  isEmptyDirectory,
}: {
  recipes: RecipeWithCosting[];
  ingredients: IngredientOption[];
  recipeOptions: RecipeOption[];
  units: UnitRow[];
  currency: string;
  canManage: boolean;
  isEmptyDirectory: boolean;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RecipeWithCosting | null>(null);
  const [, startTransition] = useTransition();

  function runAction(promise: Promise<{ ok: boolean; error?: string }>, successMessage: string) {
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
    <Modal
      open={creating}
      onClose={() => setCreating(false)}
      title="New preparation"
      description="A batch you make once and reuse across dishes. Its cost calculates itself from live ingredient prices."
      size="xl"
    >
      <RecipeForm ingredients={ingredients} preparations={recipeOptions} units={units} onSuccess={() => setCreating(false)} />
    </Modal>
  );

  if (isEmptyDirectory) {
    return (
      <>
        <Card>
          <EmptyState
            icon={Soup}
            title="No preparations yet"
            description="Preparations are the batches you make once and reuse — stock, sauce, dough. Build one here and every dish that uses it gets priced automatically. Dishes themselves are created on the Menu page."
            action={canManage ? <Button onClick={() => setCreating(true)}><Plus size={17} /> Build your first preparation</Button> : undefined}
            secondaryAction={ingredients.length === 0 ? { label: "Add ingredients first", href: "/dashboard/ingredients" } : undefined}
          />
        </Card>
        {createModal}
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar
          searchPlaceholder="Search preparations…"
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
            <Plus size={17} /> New preparation
          </Button>
        )}
      </div>

      {recipes.length === 0 ? (
        <Card>
          <EmptyState icon={Soup} title="No preparations match these filters" description="Try clearing the search box or switching the status filter." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {recipes.map(recipe => (
            <RecipeCard key={recipe.id} recipe={recipe} currency={currency} canManage={canManage} onEdit={setEditing} runAction={runAction} />
          ))}
        </div>
      )}

      {createModal}

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={`Edit ${editing?.name ?? ""}`} size="xl">
        {editing && (
          <RecipeForm
            recipe={editing}
            ingredients={ingredients}
            // A preparation can never contain itself.
            preparations={recipeOptions.filter(option => option.id !== editing.id)}
            units={units}
            onSuccess={() => setEditing(null)}
          />
        )}
      </Modal>
    </div>
  );
}

function RecipeCard({
  recipe,
  currency,
  canManage,
  onEdit,
  runAction,
}: {
  recipe: RecipeWithCosting;
  currency: string;
  canManage: boolean;
  onEdit: (recipe: RecipeWithCosting) => void;
  runAction: (promise: Promise<{ ok: boolean; error?: string }>, successMessage: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { costing } = recipe;
  const hasCycle = costing.circularPath.length > 0;

  const subRecipeCount = recipe.lines.filter(line => line.kind === "recipe").length;
  const ingredientCount = recipe.lines.length - subRecipeCount;
  const usedByDishes = recipe.usedIn.filter(entry => entry.kind === "menu_item");
  const usedByRecipes = recipe.usedIn.filter(entry => entry.kind === "recipe");

  return (
    <Card className="relative flex flex-col">
      <CardContent className="flex flex-1 flex-col pt-5">
        <div className="flex items-start justify-between gap-2">
          <button type="button" onClick={() => setExpanded(!expanded)} className="min-w-0 flex-1 text-left">
            <h3 className="truncate font-black hover:text-green-800">{recipe.name}</h3>
            <p className="mt-0.5 text-sm text-[var(--muted)]">
              {ingredientCount} ingredient{ingredientCount === 1 ? "" : "s"}
              {subRecipeCount > 0 && ` + ${subRecipeCount} preparation${subRecipeCount === 1 ? "" : "s"}`}
              {" · makes "}
              {formatQuantity(recipe.yieldQuantity, recipe.yieldUnitCode ?? "portion")}
            </p>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            {!recipe.isActive && <Badge>Archived</Badge>}
            {canManage && (
              <button type="button" aria-label={`Actions for ${recipe.name}`} onClick={() => setMenuOpen(!menuOpen)} className="rounded-lg p-1.5 text-[var(--muted)] transition hover:bg-neutral-100">
                <MoreHorizontal size={18} />
              </button>
            )}
          </div>
        </div>

        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-4 top-14 z-20 w-52 overflow-hidden rounded-xl border bg-white py-1 shadow-xl">
              <button type="button" onClick={() => { setMenuOpen(false); onEdit(recipe); }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold hover:bg-neutral-50">
                <Pencil size={15} /> Edit preparation
              </button>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); runAction(setRecipeArchived(recipe.id, recipe.isActive), recipe.isActive ? "Preparation archived" : "Preparation restored"); }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold hover:bg-neutral-50"
              >
                {recipe.isActive ? <><Archive size={15} /> Archive</> : <><ArchiveRestore size={15} /> Restore</>}
              </button>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); if (confirm(`Permanently delete “${recipe.name}”?`)) runAction(deleteRecipe(recipe.id), "Preparation deleted"); }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold text-red-700 hover:bg-red-50"
              >
                <Trash2 size={15} /> Delete
              </button>
            </div>
          </>
        )}

        {hasCycle ? (
          <p className="mt-4 flex items-start gap-2 rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-800">
            <AlertTriangle size={15} className="mt-px shrink-0" />
            Circular reference: {costing.circularPath.join(" → ")}. Remove one of these links to restore costing.
          </p>
        ) : (
          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-neutral-50 p-3">
              <p className="text-xs text-[var(--muted)]">Batch cost</p>
              <b className="tabular-nums">{formatMoney(costing.totalCostMillis, currency)}</b>
            </div>
            <div className="rounded-xl bg-neutral-50 p-3">
              <p className="text-xs text-[var(--muted)]">Per {recipe.yieldUnitCode ?? "portion"}</p>
              <b className="tabular-nums">{formatMoney(costing.costPerServingMillis, currency)}</b>
            </div>
          </div>
        )}

        {recipe.usedIn.length > 0 ? (
          <div className="mt-3 space-y-1.5 rounded-xl bg-neutral-50 p-3 text-xs text-[var(--muted)]">
            {usedByDishes.length > 0 && (
              <p className="flex items-start gap-1.5">
                <UtensilsCrossed size={13} className="mt-0.5 shrink-0 text-green-700" />
                <span>Sold in {usedByDishes.map(entry => entry.name).join(", ")}</span>
              </p>
            )}
            {usedByRecipes.length > 0 && (
              <p className="flex items-start gap-1.5">
                <Soup size={13} className="mt-0.5 shrink-0 text-amber-700" />
                <span>Used by {usedByRecipes.map(entry => entry.name).join(", ")}</span>
              </p>
            )}
          </div>
        ) : (
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-900">Not used yet — add it to a dish on the Menu page to see it earn.</p>
        )}

        {!hasCycle && costing.hasUncostedIngredient && (
          <p className="mt-3 text-xs font-semibold text-amber-700">Some lines have no cost yet, so this total is understated.</p>
        )}

        {expanded && costing.lines.length > 0 && (
          <ul className="mt-4 space-y-1.5 border-t pt-3">
            {costing.lines.map(line => (
              <li key={`${line.kind}-${line.targetId}`} className="flex items-baseline justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                  {line.kind === "recipe" && <Soup size={12} className="shrink-0 text-amber-700" />}
                  {line.name} <span className="text-[var(--muted)]">{formatQuantity(line.quantity, line.unitCode ?? line.baseUnitCode)}</span>
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
}
