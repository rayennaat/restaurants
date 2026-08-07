import { PageHeader } from "@/components/dashboard/page-header";
import { RecipeDirectory } from "@/components/recipes/recipe-directory";
import { listIngredientOptions } from "@/server/queries/ingredients";
import { listRecipeOptions, listRecipesWithCosting } from "@/server/queries/recipes";
import { can, getOrganizationUnits, requireTenant } from "@/server/tenant";

export const metadata = { title: "Recipes" };

export default async function RecipesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const tenant = await requireTenant();
  const params = await searchParams;
  const units = await getOrganizationUnits(tenant.organizationId);

  const q = typeof params.q === "string" ? params.q : undefined;
  const status = params.status === "archived" || params.status === "all" ? params.status : "active";
  const kind = params.kind === "dish" || params.kind === "preparation" ? params.kind : "all";

  const [recipes, ingredients, recipeOptions, totalCount] = await Promise.all([
    listRecipesWithCosting(tenant.organizationId, units, { q, status, kind }),
    listIngredientOptions(tenant.organizationId),
    listRecipeOptions(tenant.organizationId),
    listRecipesWithCosting(tenant.organizationId, units, { status: "all", kind: "all" }).then(all => all.length),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Kitchen"
        title="Recipes"
        description="Build preparations like mayonnaise once, then use them inside your dishes. When an ingredient price changes, every recipe above it re-prices automatically."
      />
      <RecipeDirectory
        recipes={recipes}
        ingredients={ingredients}
        recipeOptions={recipeOptions}
        units={units}
        currency={tenant.currency}
        canManage={can(tenant.role, "manage_catalog")}
        isEmptyDirectory={totalCount === 0}
      />
    </>
  );
}
