import Link from "next/link";
import { ArrowRight, Soup, UtensilsCrossed } from "lucide-react";
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

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-white px-4 py-3 shadow-sm">
        <p className="inline-flex items-center gap-2 text-sm text-[var(--muted)]">
          <UtensilsCrossed size={16} className="text-green-800" />
          Dishes can use ingredients directly or preparations from Recipes.
        </p>
        <Link href="/dashboard/recipes" className="inline-flex items-center gap-1.5 text-sm font-semibold text-green-900 hover:underline">
          Open recipes <ArrowRight size={14} />
        </Link>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Menu items</p>
          <p className="mt-1 text-2xl font-black tabular-nums">{menuItems.length}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]"><Soup size={13} /> Preparations</p>
          <p className="mt-1 text-2xl font-black tabular-nums">{preparations.length}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">Costed items</p>
          <p className="mt-1 text-2xl font-black tabular-nums text-green-900">{menuItems.filter(item => item.economics.isCosted).length}</p>
        </div>
      </div>

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
