import { PageHeader } from "@/components/dashboard/page-header";
import { IngredientManager } from "@/components/ingredients/ingredient-manager";
import { ingredientFilters } from "@/lib/validation";
import { listIngredientCategories, listIngredients } from "@/server/queries/ingredients";
import { can, getOrganizationUnits, requireTenant } from "@/server/tenant";

export const metadata = { title: "Ingredients" };

export default async function IngredientsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const tenant = await requireTenant();
  const params = await searchParams;

  // Unknown or malformed query strings fall back to defaults rather than 500.
  const parsed = ingredientFilters.safeParse(params);
  const filters = parsed.success ? parsed.data : ingredientFilters.parse({});

  const [rows, categories, units, unfilteredCount] = await Promise.all([
    listIngredients(tenant.organizationId, tenant.locationId, filters),
    listIngredientCategories(tenant.organizationId),
    getOrganizationUnits(tenant.organizationId),
    listIngredients(tenant.organizationId, tenant.locationId, { status: "all" }).then(all => all.length),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Catalog"
        title="Ingredients"
        description="Everything you buy, count and cook with. Costs here feed inventory value, recipe costing and menu margin."
      />
      <IngredientManager
        rows={rows}
        units={units}
        categories={categories}
        currency={tenant.currency}
        canManage={can(tenant.role, "manage_catalog")}
        isEmptyCatalog={unfilteredCount === 0}
      />
    </>
  );
}
