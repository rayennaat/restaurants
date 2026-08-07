"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Archive, ArchiveRestore, ChefHat, MoreHorizontal, Pencil, Plus, Soup, Trash2 } from "lucide-react";
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
import type { RecipeOption, RecipeWithCosting } from "@/server/queries/recipes";

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
    <Modal open={creating} onClose={() => setCreating(false)} title="New recipe" description="Add ingredients or preparations — the cost calculates itself from live prices." size="xl">
      <RecipeForm ingredients={ingredients} preparations={recipeOptions} units={units} onSuccess={() => setCreating(false)} />
    </Modal>
  );

  if (isEmptyDirectory) {
    return (
      <>
        <Card>
          <EmptyState
            icon={ChefHat}
            title="No recipes yet"
            description="A recipe turns ingredient quantities into a real cost per serving. Build preparations like mayonnaise once, then reuse them inside your dishes."
            action={canManage ? <Button onClick={() => setCreating(true)}><Plus size={17} /> Build your first recipe</Button> : undefined}
            secondaryAction={ingredients.length === 0 ? { label: "Add ingredients first", href: "/dashboard/ingredients" } : undefined}
          />
        </Card>
        {createModal}
      </>
    );
  }

  const dishes = recipes.filter(recipe => !recipe.isPreparation);
  const preparations = recipes.filter(recipe => recipe.isPreparation);

  const cardProps = { currency, canManage, onEdit: setEditing, runAction };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterBar
          searchPlaceholder="Search recipes…"
          filters={[
            {
              name: "kind",
              label: "Type",
              defaultValue: "all",
              options: [
                { value: "all", label: "All types" },
                { value: "dish", label: "Dishes" },
                { value: "preparation", label: "Preparations" },
              ],
            },
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
          <EmptyState icon={ChefHat} title="No recipes match these filters" description="Try clearing the search box or switching the type and status filters." />
        </Card>
      ) : (
        <>
          {dishes.length > 0 && (
            <RecipeSection
              icon={ChefHat}
              title="Dishes"
              description="What you sell. Link these to menu items to see food cost and margin."
              recipes={dishes}
              {...cardProps}
            />
          )}
          {preparations.length > 0 && (
            <RecipeSection
              icon={Soup}
              title="Preparations"
              description="Made in batches and used inside other recipes. Their cost flows into every dish that consumes them."
              recipes={preparations}
              {...cardProps}
            />
          )}
        </>
      )}

      {createModal}

      <Modal open={Boolean(editing)} onClose={() => setEditing(null)} title={`Edit ${editing?.name ?? ""}`} size="xl">
        {editing && (
          <RecipeForm
            recipe={editing}
            ingredients={ingredients}
            // A recipe can never contain itself.
            preparations={recipeOptions.filter(option => option.id !== editing.id)}
            units={units}
            onSuccess={() => setEditing(null)}
          />
        )}
      </Modal>
    </div>
  );
}

function RecipeSection({
  icon: Icon,
  title,
  description,
  recipes,
  ...cardProps
}: {
  icon: typeof ChefHat;
  title: string;
  description: string;
  recipes: RecipeWithCosting[];
  currency: string;
  canManage: boolean;
  onEdit: (recipe: RecipeWithCosting) => void;
  runAction: (promise: Promise<{ ok: boolean; error?: string }>, successMessage: string) => void;
}) {
  return (
    <section>
      <header className="mb-3">
        <h2 className="flex items-center gap-2 text-lg font-black">
          <Icon size={18} className="text-green-700" />
          {title}
          <span className="text-sm font-semibold text-[var(--muted)]">({recipes.length})</span>
        </h2>
        <p className="mt-0.5 text-sm text-[var(--muted)]">{description}</p>
      </header>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {recipes.map(recipe => (
          <RecipeCard key={recipe.id} recipe={recipe} {...cardProps} />
        ))}
      </div>
    </section>
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
  const primaryMenuItem = recipe.menuItems[0];
  const hasCycle = costing.circularPath.length > 0;

  const subRecipeCount = recipe.lines.filter(line => line.kind === "recipe").length;
  const ingredientCount = recipe.lines.length - subRecipeCount;

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
                <Pencil size={15} /> Edit recipe
              </button>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); runAction(setRecipeArchived(recipe.id, recipe.isActive), recipe.isActive ? "Recipe archived" : "Recipe restored"); }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-semibold hover:bg-neutral-50"
              >
                {recipe.isActive ? <><Archive size={15} /> Archive</> : <><ArchiveRestore size={15} /> Restore</>}
              </button>
              <button
                type="button"
                onClick={() => { setMenuOpen(false); if (confirm(`Permanently delete “${recipe.name}”?`)) runAction(deleteRecipe(recipe.id), "Recipe deleted"); }}
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
              <p className="text-xs text-[var(--muted)]">Per {recipe.yieldUnitCode ?? "serving"}</p>
              <b className="tabular-nums">{formatMoney(costing.costPerServingMillis, currency)}</b>
            </div>
          </div>
        )}

        {recipe.isPreparation ? (
          <p className="mt-3 rounded-xl bg-neutral-50 p-3 text-xs text-[var(--muted)]">
            {recipe.usedIn.length > 0 ? <>Used in {recipe.usedIn.map(entry => entry.name).join(", ")}</> : <>Not used in any recipe yet.</>}
          </p>
        ) : primaryMenuItem ? (
          <div className="mt-3 rounded-xl bg-green-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-xs font-semibold text-green-800">{primaryMenuItem.name}</p>
              {primaryMenuItem.economics.isCosted && <Badge tone={foodCostTone(primaryMenuItem.economics.foodCostPercent)}>{formatPercent(primaryMenuItem.economics.foodCostPercent)} food cost</Badge>}
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
          <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-semibold text-amber-900">No menu item linked — add one to see food cost % and margin.</p>
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
