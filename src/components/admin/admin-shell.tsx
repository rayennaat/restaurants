"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Building2, ChevronRight, KeyRound, LayoutDashboard, LogOut, Users } from "lucide-react";
import { cn } from "@/lib/utils";

const links = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/organizations", label: "Organizations", icon: Building2 },
  { href: "/admin/invitations", label: "Owner invitations", icon: KeyRound },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/audit", label: "Admin audit", icon: Activity },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="min-h-screen bg-[var(--background)]">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/admin" className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-green-900 text-sm font-black text-white">Y</span>
            <span><b className="block text-sm">Yield Platform</b><small className="text-xs text-[var(--muted)]">Internal administration</small></span>
          </Link>
          <form action="/auth/signout" method="post"><button className="inline-flex h-9 items-center gap-2 rounded-lg border bg-white px-3 text-sm font-semibold hover:bg-neutral-50"><LogOut size={15} aria-hidden="true" /> Sign out</button></form>
        </div>
      </header>
      <div className="mx-auto flex max-w-[1500px] flex-col lg:flex-row">
        <aside className="border-b bg-white lg:min-h-[calc(100vh-65px)] lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r">
          <nav aria-label="Platform administration" className="flex gap-1 overflow-x-auto p-3 lg:block lg:space-y-1">
            {links.map(({ href, label, icon: Icon }) => {
              const active = href === "/admin" ? pathname === href : pathname.startsWith(href);
              return <Link key={href} href={href} className={cn("flex min-w-max items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition", active ? "bg-green-50 text-green-900" : "text-[var(--muted)] hover:bg-neutral-50 hover:text-neutral-900")}><Icon size={16} aria-hidden="true" />{label}{active && <ChevronRight size={14} className="ml-auto hidden lg:block" aria-hidden="true" />}</Link>;
            })}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
