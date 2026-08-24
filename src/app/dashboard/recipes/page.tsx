import Link from "next/link";
import { ArrowRight, Soup, UtensilsCrossed } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { RecipeDirectory } from "@/components/recipes/recipe-directory";
import { listIngredientOptions } from "@/server/queries/ingredients";
import { listRecipeOptions, listRecipesWithCosting } from "@/server/queries/recipes";
import { hasPermission, getOrganizationUnits, requireTenant } from "@/server/tenant";

export const metadata = { title: "Recipes" };

export default async function RecipesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const tenant = await requireTenant();
  const params = await searchParams;
  const units = await getOrganizationUnits(tenant.organizationId);

  const q = typeof params.q === "string" ? params.q : undefined;
  const status = params.status === "archived" || params.status === "all" ? params.status : "active";

  const [recipes, ingredients, recipeOptions, totalCount] = await Promise.all([
    listRecipesWithCosting(tenant.organizationId, units, { q, status }),
    listIngredientOptions(tenant.organizationId),
    listRecipeOptions(tenant.organizationId),
    listRecipesWithCosting(tenant.organizationId, units, { status: "all" }).then(all => all.length),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Kitchen"
        title="Recipes"
        description="Build a preparation like mayonnaise or stock once, then use it inside your dishes on the Menu page. When an ingredient price changes, every preparation and dish above it re-prices automatically."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-white px-4 py-3 shadow-sm">
        <p className="inline-flex items-center gap-2 text-sm text-[var(--muted)]">
          <Soup size={16} className="text-amber-700" />
          Preparations feed dish costing on the Menu page.
        </p>
        <Link href="/dashboard/menu" className="inline-flex items-center gap-1.5 text-sm font-semibold text-green-900 hover:underline">
          Open menu <ArrowRight size={14} />
        </Link>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Preparations</p>
          <p className="mt-1 text-2xl font-black tabular-nums">{recipes.length}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Ingredients available</p>
          <p className="mt-1 text-2xl font-black tabular-nums">{ingredients.length}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]"><UtensilsCrossed size={13} /> Menu connection</p>
          <p className="mt-1 text-sm font-semibold text-green-900">Used by dishes downstream</p>
        </div>
      </div>

      <RecipeDirectory
        recipes={recipes}
        ingredients={ingredients}
        recipeOptions={recipeOptions}
        units={units}
        currency={tenant.currency}
        canManage={hasPermission(tenant.role, "manage_recipes")}
        isEmptyDirectory={totalCount === 0}
      />
    </>
  );
}
