import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type TabItem = {
  label: string;
  href: string;
  icon?: LucideIcon;
  current: boolean;
};

/**
 * A row of links that switch between views of the same area.
 *
 * One component for two callers that had grown the same design independently:
 * the Reports tabs and the section sub-navigation. They are the same gesture —
 * *stay here, show me a different cut* — so they should not be two treatments,
 * and now cannot become two by accident.
 *
 * Rendered as a `<nav>` of links rather than buttons because each tab is a real
 * URL: shareable, refresh-safe, and reachable with the back button. `aria-current`
 * carries the selected state to assistive technology, which a colour change
 * alone would not.
 */
export function TabNav({ items, label, className }: { items: TabItem[]; label: string; className?: string }) {
  if (items.length < 2) return null;

  return (
    <nav aria-label={label} className={cn("flex flex-wrap gap-2", className)}>
      {items.map(item => {
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={item.current ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-semibold transition",
              item.current
                ? "border-green-800 bg-green-800 text-white"
                : "border-[var(--border)] bg-white text-neutral-700 hover:bg-neutral-50 hover:text-neutral-900",
            )}
          >
            {Icon && <Icon size={15} aria-hidden className={cn(item.current ? "text-white" : "text-neutral-500")} />}
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
