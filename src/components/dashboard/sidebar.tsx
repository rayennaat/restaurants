import Link from "next/link";
import { BarChart3, Boxes, Carrot, ChefHat, LayoutDashboard, PackagePlus, Settings, Store, Trash2, Truck, UtensilsCrossed } from "lucide-react";

const links = [
  ["Overview", "/dashboard", LayoutDashboard],
  ["Ingredients", "/dashboard/ingredients", Carrot],
  ["Inventory", "/dashboard/inventory", Boxes],
  ["Purchases", "/dashboard/purchases", PackagePlus],
  ["Suppliers", "/dashboard/suppliers", Truck],
  ["Recipes", "/dashboard/recipes", ChefHat],
  ["Menu", "/dashboard/menu", UtensilsCrossed],
  ["Waste", "/dashboard/waste", Trash2],
  ["Reports", "/dashboard/reports", BarChart3],
  ["Settings", "/dashboard/settings", Settings],
] as const;

export function Sidebar({ organizationName }: { organizationName: string }) {
  return (
    <aside className="hidden min-h-screen w-64 shrink-0 border-r bg-white p-4 lg:block">
      <Link href="/dashboard" className="flex items-center gap-3 rounded-2xl p-3">
        <span className="grid size-11 place-items-center rounded-xl bg-green-800 text-white">
          <Store size={21} />
        </span>
        <span>
          <b className="block">PlatePilot</b>
          <small className="block max-w-36 truncate text-[var(--muted)]">{organizationName}</small>
        </span>
      </Link>
      <nav className="mt-8 space-y-1">
        {links.map(([label, href, Icon]) => (
          <Link key={href} href={href} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-green-50 hover:text-green-900">
            <Icon size={18} />
            {label}
          </Link>
        ))}
      </nav>
      <form action="/auth/signout" method="post" className="mt-10">
        <button className="w-full rounded-xl border px-3 py-2 text-sm font-semibold transition hover:bg-neutral-50">Sign out</button>
      </form>
    </aside>
  );
}
