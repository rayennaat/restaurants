"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { NAV_SECTIONS, isSectionOpen, resolveActiveNav, type NavItem } from "@/lib/navigation";
import { cn } from "@/lib/utils";

/**
 * The navigation tree, rendered from {@link NAV_SECTIONS}.
 *
 * One component serves the desktop sidebar and the mobile drawer. They differ
 * only in the frame around them, so sharing the tree is what guarantees a
 * feature added to the model appears in both.
 *
 * ## The disclosure interaction
 *
 * A section header is a link *and* a disclosure, which is the one place this
 * could have become fiddly. It is split in two controls:
 *
 *   [ icon  Sales ............... ⌄ ]
 *     └ navigates                 └ expands
 *
 * Clicking the label goes to the section's main page — never a dead click — and
 * arriving there opens the section automatically, so the sub-pages reveal
 * themselves without the user knowing the chevron exists. The chevron is for
 * looking ahead without leaving the current screen. Only the chevron carries
 * `aria-expanded`, because only the chevron is the disclosure.
 */

/** Shared row geometry, so a link and a disclosure button line up exactly. */
const ROW = "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm transition";

function Row({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: ReturnType<typeof resolveActiveNav>;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const autoOpen = isSectionOpen(item, active);

  // `null` means "follow the route"; a boolean is the user's own choice.
  const [manual, setManual] = useState<boolean | null>(null);

  // The route wins back control whenever it changes what this section *should*
  // do. Without this, someone who collapsed Sales by hand would then navigate
  // into Import sales and find the section still shut — the sidebar quietly
  // refusing to show them where they are. Adjusting during render rather than
  // in an effect keeps it to a single pass, matching {@link FilterBar}.
  const [lastAutoOpen, setLastAutoOpen] = useState(autoOpen);
  if (autoOpen !== lastAutoOpen) {
    setLastAutoOpen(autoOpen);
    setManual(null);
  }

  const open = manual ?? autoOpen;

  const isCurrent = active.href === item.href;
  // A collapsed rail cannot show children, so the parent stands in for the
  // section — highlighting it keeps the user oriented at icon width.
  const highlight = isCurrent || (collapsed && active.parentHref === item.href);
  const panelId = `nav-${item.href.replace(/\W+/g, "-")}`;
  const Icon = item.icon;

  return (
    <li>
      <div className="relative flex items-center">
        {highlight && <span aria-hidden className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-green-700" />}
        <Link
          href={item.href}
          onClick={onNavigate}
          aria-current={isCurrent ? "page" : undefined}
          title={collapsed ? item.label : undefined}
          className={cn(
            ROW,
            collapsed && "justify-center px-0",
            highlight
              ? "bg-green-50 font-bold text-green-900"
              : "font-semibold text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900",
          )}
        >
          <Icon size={18} className={cn("shrink-0", highlight ? "text-green-700" : "text-neutral-500")} />
          <span className={cn("truncate", collapsed && "sr-only")}>{item.label}</span>
        </Link>

        {item.children && !collapsed && (
          <button
            type="button"
            onClick={() => setManual(!open)}
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`${open ? "Hide" : "Show"} ${item.label} pages`}
            className="ml-0.5 grid size-7 shrink-0 place-items-center rounded-lg text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700"
          >
            <ChevronDown size={15} className={cn("transition-transform", open && "rotate-180")} />
          </button>
        )}
      </div>

      {item.children && !collapsed && (
        // Kept mounted and hidden rather than unmounted, so the chevron's
        // `aria-controls` always points at a real element.
        <ul id={panelId} hidden={!open} className="mt-0.5 space-y-0.5 border-l pl-3 ml-4">
          {item.children.map(child => {
            const childActive = active.href === child.href;
            return (
              <li key={child.href}>
                <Link
                  href={child.href}
                  onClick={onNavigate}
                  aria-current={childActive ? "page" : undefined}
                  className={cn(
                    "block truncate rounded-lg px-2.5 py-1.5 text-sm transition",
                    childActive
                      ? "bg-green-50 font-bold text-green-900"
                      : "font-medium text-[var(--muted)] hover:bg-neutral-100 hover:text-neutral-900",
                  )}
                >
                  {child.label}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function NavTree({
  pathname,
  collapsed = false,
  onNavigate,
}: {
  pathname: string;
  collapsed?: boolean;
  /** Called after any navigation — the mobile drawer uses it to close itself. */
  onNavigate?: () => void;
}) {
  const active = resolveActiveNav(pathname);

  return (
    <nav aria-label="Main" className="space-y-5">
      {NAV_SECTIONS.map((section, index) => (
        <div key={section.title ?? `section-${index}`}>
          {section.title && (
            <h2
              className={cn(
                "mb-1.5 px-2.5 text-[11px] font-black uppercase tracking-[.14em] text-neutral-400",
                collapsed && "sr-only",
              )}
            >
              {section.title}
            </h2>
          )}
          <ul className="space-y-0.5">
            {section.items.map(item => (
              <Row key={item.href} item={item} active={active} collapsed={collapsed} onNavigate={onNavigate} />
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
