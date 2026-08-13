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
