import { PageHeader } from "@/components/dashboard/page-header";
import { MenuTable } from "@/components/recipes/menu-table";
import { listIngredientOptions } from "@/server/queries/ingredients";
import { listMenuItems } from "@/server/queries/menu";
import { listRecipesWithCosting } from "@/server/queries/recipes";
import { hasPermission, getOrganizationUnits, requireTenant } from "@/server/tenant";

export const metadata = { title: "Menu" };

export default async function MenuPage() {
  const tenant = await requireTenant();
  const units = await getOrganizationUnits(tenant.organizationId);

  const [menuItems, allMenuItemsCount, ingredients, preparations] = await Promise.all([
    listMenuItems(tenant.organizationId, units, { status: "active" }),
    listMenuItems(tenant.organizationId, units, { status: "all" }).then(all => all.length),
    listIngredientOptions(tenant.organizationId),
    listRecipesWithCosting(tenant.organizationId, units, { status: "active" }),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Kitchen"
        title="Menu"
        description="What you sell, what it costs and what it earns. Costs come straight from current ingredient prices, so a supplier price change re-prices every dish here."
      />
      <MenuTable
        rows={menuItems}
        ingredients={ingredients}
        preparations={preparations.map(recipe => ({
          id: recipe.id,
          name: recipe.name,
          yieldQuantity: String(recipe.yieldQuantity),
          yieldUnitCode: recipe.yieldUnitCode,
        }))}
        preparationCosts={preparations.map(recipe => ({
          id: recipe.id,
          yieldUnitCode: recipe.yieldUnitCode,
          costPerYieldUnitMillis: recipe.costing.costPerServingMillis,
        }))}
        units={units}
        currency={tenant.currency}
        canManage={hasPermission(tenant.role, "manage_recipes")}
        isEmptyMenu={allMenuItemsCount === 0}
      />
    </>
  );
}
