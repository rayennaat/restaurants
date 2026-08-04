import Link from "next/link";
import { Boxes, LayoutDashboard, PackagePlus, Trash2 } from "lucide-react";
const links = [["Home", "/dashboard", LayoutDashboard], ["Stock", "/dashboard/inventory", Boxes], ["Buy", "/dashboard/purchases", PackagePlus], ["Waste", "/dashboard/waste", Trash2]] as const;
export function MobileNav() { return <nav className="fixed inset-x-3 bottom-3 z-50 flex justify-around rounded-2xl border bg-white/95 p-2 shadow-2xl backdrop-blur lg:hidden">{links.map(([label, href, Icon]) => <Link key={href} href={href} className="flex min-w-16 flex-col items-center gap-1 rounded-xl px-3 py-2 text-xs font-bold"><Icon size={18}/>{label}</Link>)}</nav>; }
