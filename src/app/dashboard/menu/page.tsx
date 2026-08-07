import { PageHeader } from "@/components/dashboard/page-header";
import { MenuTable } from "@/components/recipes/menu-table";
import { listMenuItems } from "@/server/queries/menu";
import { listRecipeOptions } from "@/server/queries/recipes";
import { can, getOrganizationUnits, requireTenant } from "@/server/tenant";

export const metadata = { title: "Menu" };

export default async function MenuPage() {
  const tenant = await requireTenant();
  const units = await getOrganizationUnits(tenant.organizationId);

  const [menuItems, recipes, allMenuItemsCount] = await Promise.all([
    listMenuItems(tenant.organizationId, units, { status: "active" }),
    listRecipeOptions(tenant.organizationId),
    listMenuItems(tenant.organizationId, units, { status: "all" }).then(all => all.length),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Sales"
        title="Menu"
        description="Your selling prices with live recipe costs. When an ingredient price changes, every linked menu item instantly shows the new food cost percentage and margin."
      />
      <MenuTable rows={menuItems} recipes={recipes} currency={tenant.currency} canManage={can(tenant.role, "manage_catalog")} isEmptyMenu={allMenuItemsCount === 0} />
    </>
  );
}
