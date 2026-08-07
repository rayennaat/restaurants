import { PageHeader } from "@/components/dashboard/page-header";
import { RecipeDirectory } from "@/components/recipes/recipe-directory";
import { listIngredientOptions } from "@/server/queries/ingredients";
import { listRecipesWithCosting } from "@/server/queries/recipes";
import { can, getOrganizationUnits, requireTenant } from "@/server/tenant";

export const metadata = { title: "Recipes" };

export default async function RecipesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const tenant = await requireTenant();
  const params = await searchParams;
  const units = await getOrganizationUnits(tenant.organizationId);

  const q = typeof params.q === "string" ? params.q : undefined;
  const status = params.status === "archived" || params.status === "all" ? params.status : "active";

  const [recipes, ingredients, totalCount] = await Promise.all([
    listRecipesWithCosting(tenant.organizationId, units, { q, status }),
    listIngredientOptions(tenant.organizationId),
    listRecipesWithCosting(tenant.organizationId, units, { status: "all" }).then(all => all.length),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Kitchen"
        title="Recipes"
        description="Ingredient quantities, calculated food cost and yield. Every time an ingredient price changes, every recipe re-prices itself automatically."
      />
      <RecipeDirectory
        recipes={recipes}
        ingredients={ingredients}
        units={units}
        currency={tenant.currency}
        canManage={can(tenant.role, "manage_catalog")}
        isEmptyDirectory={totalCount === 0}
      />
    </>
  );
}
