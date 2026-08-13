"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, PanelLeftClose, PanelLeftOpen, Store } from "lucide-react";
import { NavTree } from "@/components/dashboard/nav-tree";
import { cn } from "@/lib/utils";

/**
 * The desktop sidebar.
 *
 * Narrowed from `w-64` to `w-60`, and to a `w-16` icon rail when collapsed —
 * the brief's complaint was that navigation was taking attention the content
 * should have. Grouping did most of that work; the width does the rest.
 *
 * `sticky` rather than `fixed`, with `self-start`, so the rail stays in flow
 * beside the main column and needs no compensating offset. Aligning to the
 * start is what lets `h-screen` mean one viewport — stretched to full page
 * height it would only begin sticking after you scrolled past its bottom edge,
 * which reads as broken.
 */

const STORAGE_KEY = "platepilot:sidebar-collapsed";

/**
 * The collapse preference, as an external store.
 *
 * `localStorage` is exactly what `useSyncExternalStore` is for: state that
 * lives outside React and that the server cannot see. Reading it in an effect
 * and calling `setState` would work, but it schedules a second render pass on
 * every mount and React's own lint rules flag it. This subscribes instead, so
 * hydration renders the server snapshot (`false`) and React swaps in the real
 * value itself.
 *
 * `storage` fires in *other* tabs, so a second tab follows along; the setter
 * dispatches locally because the browser deliberately does not echo the event
 * back to the tab that caused it.
 */
const collapseStore = {
  subscribe(onChange: () => void) {
    window.addEventListener("storage", onChange);
    window.addEventListener("platepilot:sidebar", onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener("platepilot:sidebar", onChange);
    };
  },
  get: () => window.localStorage.getItem(STORAGE_KEY) === "1",
  // The server has no preference to read, so it renders expanded — the state a
  // first-time visitor gets anyway.
  getServer: () => false,
  set(next: boolean) {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    window.dispatchEvent(new Event("platepilot:sidebar"));
  },
};

export function Sidebar({ organizationName }: { organizationName: string }) {
  const pathname = usePathname();
  const collapsed = useSyncExternalStore(collapseStore.subscribe, collapseStore.get, collapseStore.getServer);

  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 self-start flex-col overflow-y-auto border-r border-[var(--border)] bg-white/80 lg:flex",
        collapsed ? "w-16 px-2 py-4" : "w-60 p-3",
      )}
    >
      <Link
        href="/dashboard"
        title={collapsed ? `PlatePilot — ${organizationName}` : undefined}
        className={cn(
          "flex min-w-0 items-center gap-2.5 rounded-xl p-1.5 transition hover:bg-neutral-100",
          collapsed && "justify-center p-1",
        )}
      >
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-green-800 text-white">
          <Store size={19} />
        </span>
        {!collapsed && (
          <span className="min-w-0">
            <b className="block truncate text-sm leading-tight">PlatePilot</b>
            <small className="block truncate text-xs text-[var(--muted)]">{organizationName}</small>
          </span>
        )}
      </Link>

      <div className="mt-6 flex-1">
        <NavTree pathname={pathname} collapsed={collapsed} />
      </div>

      <div className={cn("mt-4 space-y-1 border-t pt-3", collapsed && "space-y-2")}>
        <button
          type="button"
          onClick={() => collapseStore.set(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-semibold text-[var(--muted)] transition hover:bg-neutral-100 hover:text-neutral-900",
            collapsed && "justify-center px-0",
          )}
        >
          {collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          {!collapsed && "Collapse"}
        </button>

        <form action="/auth/signout" method="post">
          <button
            aria-label="Sign out"
            title={collapsed ? "Sign out" : undefined}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-xl border bg-white px-3 py-2 text-sm font-semibold transition hover:bg-neutral-50",
              collapsed && "px-0",
            )}
          >
            <LogOut size={16} className={cn(!collapsed && "hidden")} aria-hidden />
            {!collapsed && "Sign out"}
          </button>
        </form>
      </div>
    </aside>
  );
}
