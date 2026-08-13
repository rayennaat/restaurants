import { PageHeader } from "@/components/dashboard/page-header";
import { SectionNav } from "@/components/dashboard/section-nav";
import { IngredientManager } from "@/components/ingredients/ingredient-manager";
import { ingredientFilters } from "@/lib/validation";
import { listIngredientCategories, listIngredients } from "@/server/queries/ingredients";
import { hasPermission, getOrganizationUnits, requireTenant } from "@/server/tenant";

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
        eyebrow="Inventory"
        title="Ingredients"
        description="Everything you buy, count and cook with. Costs here feed inventory value, recipe costing and menu margin."
      />

      <SectionNav />
      <IngredientManager
        rows={rows}
        units={units}
        categories={categories}
        currency={tenant.currency}
        canManage={hasPermission(tenant.role, "manage_ingredients")}
        isEmptyCatalog={unfilteredCount === 0}
      />
    </>
  );
}
