"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, Menu, Store, X } from "lucide-react";
import { NavTree } from "@/components/dashboard/nav-tree";

/**
 * Mobile navigation: a top bar with a menu button, and a drawer over the page.
 *
 * This replaces a fixed bottom bar that held four links — Home, Stock, Buy,
 * Waste. Everything else in the product, including sales, recipes, reports and
 * team, was simply unreachable on a phone. The drawer renders the same
 * {@link NavTree} as the desktop sidebar, so mobile is no longer a subset.
 *
 * ## Behaviour the brief asks for, and how each is met
 *
 * *Overlays rather than pushing the page* — the drawer is `fixed`, so the layout
 * underneath never shifts and the current route stays rendered behind it.
 *
 * *Closes after navigating* — `NavTree`'s `onNavigate` fires on any link, so a
 * tap both routes and dismisses. Closing on `pathname` change alone would miss a
 * tap on the page you are already viewing, leaving the drawer stuck open.
 *
 * *Keyboard and screen reader* — Escape closes, focus moves to the panel on open
 * and returns to the menu button on close, the overlay is `aria-hidden` decor,
 * and the panel is a labelled `role="dialog"`. Background scrolling is locked
 * while it is open so the page behind cannot be dragged away underneath.
 *
 * Native `<dialog>` would give some of this for free, and {@link Modal} uses it
 * for exactly that reason. It is the wrong fit here: a drawer is a persistent
 * region that slides in, not a modal interruption, and `showModal()` also
 * insists on centring in the top layer.
 */
export function MobileNav({ organizationName }: { organizationName: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape closes, and focus lands somewhere useful in both directions.
  useEffect(() => {
    if (!open) return;

    panelRef.current?.focus();
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <>
      {/* Sticky so the way out of a long table is always one tap away. */}
      <header className="sticky top-0 z-40 flex items-center gap-3 border-b bg-white/95 px-4 py-3 backdrop-blur lg:hidden">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
          className="-ml-1 grid size-10 place-items-center rounded-xl border text-neutral-700 transition hover:bg-neutral-50"
        >
          <Menu size={20} />
        </button>
        <Link href="/dashboard" className="flex min-w-0 items-center gap-2">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-green-800 text-white">
            <Store size={17} />
          </span>
          <span className="min-w-0">
            <b className="block truncate text-sm leading-tight">PlatePilot</b>
            <small className="block truncate text-xs text-[var(--muted)]">{organizationName}</small>
          </span>
        </Link>
      </header>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button type="button" aria-hidden tabIndex={-1} onClick={close} className="absolute inset-0 bg-black/40 backdrop-blur-sm" />

          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label="Main menu"
            tabIndex={-1}
            className="absolute inset-y-0 left-0 flex w-[17rem] max-w-[85vw] flex-col overflow-y-auto bg-white shadow-2xl outline-none"
          >
            <div className="flex items-center justify-between gap-2 border-b p-3">
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-green-800 text-white">
                  <Store size={19} />
                </span>
                <span className="min-w-0">
                  <b className="block truncate text-sm leading-tight">PlatePilot</b>
                  <small className="block truncate text-xs text-[var(--muted)]">{organizationName}</small>
                </span>
              </span>
              <button
                type="button"
                onClick={close}
                aria-label="Close menu"
                className="grid size-9 shrink-0 place-items-center rounded-xl text-[var(--muted)] transition hover:bg-neutral-100"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 p-3">
              <NavTree pathname={pathname} onNavigate={close} />
            </div>

            <form action="/auth/signout" method="post" className="border-t p-3">
              <button className="flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition hover:bg-neutral-50">
                <LogOut size={16} aria-hidden />
                Sign out
              </button>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
