"use client";

import { usePathname } from "next/navigation";
import { resolveActiveNav, sectionChildren } from "@/lib/navigation";
import { TabNav } from "@/components/ui/tab-nav";

/**
 * Sub-navigation across the screens of one section.
 *
 * Grouping the sidebar solved crowding, but it moved secondary screens behind a
 * disclosure. This puts them back in plain sight *on* the section they belong
 * to, which covers the two cases the sidebar cannot: browsing with the rail
 * collapsed to icons, and landing on a detail page from a link.
 *
 * It renders from {@link sectionChildren}, so it is the same tree the sidebar
 * draws — a screen added to the model appears in both without further work, and
 * a section with no second tier renders nothing at all.
 */
export function SectionNav({ className = "mb-6" }: { className?: string }) {
  const pathname = usePathname();
  const active = resolveActiveNav(pathname);

  const items = sectionChildren(pathname).map(child => ({
    label: child.label,
    href: child.href,
    icon: child.icon,
    current: active.href === child.href,
  }));

  return <TabNav items={items} label="Section" className={className} />;
}
