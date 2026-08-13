import {
  ArrowLeftRight,
  BarChart3,
  Boxes,
  Carrot,
  ChefHat,
  ClipboardList,
  FileUp,
  History,
  LayoutDashboard,
  PackagePlus,
  Receipt,
  Settings,
  Trash2,
  Truck,
  UtensilsCrossed,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * The navigation model.
 *
 * Pure data and pure functions — no React, no Next.js — so the structure can be
 * read in one sitting and the active-state rule can be unit tested directly.
 * Both the desktop sidebar and the mobile drawer render from this one source,
 * which is what stops the two drifting apart.
 *
 * ## Why grouping, and why these groups
 *
 * The flat list had fifteen equal-weight entries, which asks a new employee to
 * hold the entire product in their head before their first click. These groups
 * follow the questions a restaurant actually asks — *what did we sell, what do
 * we hold, what did we buy, what do we cook, how are we doing* — rather than the
 * shape of the database.
 *
 * Secondary screens become children of the section they belong to: importing
 * sales lives under Sales, stock counts and transfers under Inventory,
 * suppliers under Purchases. Nothing was removed from the navigation; the
 * second tier is revealed by the section rather than competing with it.
 */

export type NavChild = { label: string; href: string; icon: LucideIcon };

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Secondary screens belonging to this section. */
  children?: NavChild[];
};

export type NavSection = {
  /** Group heading. Null renders the items with no heading above them. */
  title: string | null;
  items: NavItem[];
};

/**
 * Restaurant language throughout, never schema language: "Stock counts" rather
 * than reconciliation, "Transfers" rather than ledger movements.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    title: null,
    items: [{ label: "Overview", href: "/dashboard", icon: LayoutDashboard }],
  },
  {
    title: "Operations",
    items: [
      {
        label: "Sales",
        href: "/dashboard/sales",
        icon: Receipt,
        children: [
          { label: "All sales", href: "/dashboard/sales", icon: Receipt },
          { label: "Import sales", href: "/dashboard/sales/import", icon: FileUp },
          { label: "Import history", href: "/dashboard/sales/imports", icon: History },
        ],
      },
      {
        label: "Inventory",
        href: "/dashboard/inventory",
        icon: Boxes,
        children: [
          { label: "Stock on hand", href: "/dashboard/inventory", icon: Boxes },
          { label: "Ingredients", href: "/dashboard/ingredients", icon: Carrot },
          { label: "Stock counts", href: "/dashboard/inventory/counts", icon: ClipboardList },
          { label: "Transfers", href: "/dashboard/transfers", icon: ArrowLeftRight },
        ],
      },
      {
        label: "Purchases",
        href: "/dashboard/purchases",
        icon: PackagePlus,
        children: [
          { label: "Purchases", href: "/dashboard/purchases", icon: PackagePlus },
          { label: "Suppliers", href: "/dashboard/suppliers", icon: Truck },
        ],
      },
      { label: "Waste", href: "/dashboard/waste", icon: Trash2 },
    ],
  },
  {
    title: "Kitchen",
    items: [
      { label: "Recipes", href: "/dashboard/recipes", icon: ChefHat },
      { label: "Menu", href: "/dashboard/menu", icon: UtensilsCrossed },
    ],
  },
  {
    title: "Business",
    items: [
      { label: "Reports", href: "/dashboard/reports", icon: BarChart3 },
      { label: "Team", href: "/dashboard/settings/team", icon: Users },
      { label: "Settings", href: "/dashboard/settings", icon: Settings },
    ],
  },
];

/** Every item and child, flattened — used by the active-state resolver. */
const ALL_LINKS: { href: string; parentHref: string | null }[] = NAV_SECTIONS.flatMap(section =>
  section.items.flatMap(item => [
    { href: item.href, parentHref: null },
    ...(item.children ?? []).map(child => ({ href: child.href, parentHref: item.href })),
  ]),
);

/**
 * Whether `href` is the page currently being viewed, or an ancestor of it.
 *
 * `/dashboard` is matched exactly: as a prefix it would light up for every
 * screen in the product. Everything else matches itself and its descendants, so
 * a detail page like `/dashboard/sales/abc123` keeps Sales highlighted.
 */
function covers(href: string, pathname: string) {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export type ActiveNav = {
  /** The most specific matching link. Drives the highlighted row. */
  href: string | null;
  /** The section whose disclosure should be open. Null when nothing matches. */
  parentHref: string | null;
};

/**
 * Resolves which navigation entry the current path belongs to.
 *
 * Longest match wins, which is the whole subtlety here. `/dashboard/sales/import`
 * is covered by both "Sales" (`/dashboard/sales`) and "Import sales"; picking the
 * first match would highlight the parent and leave the user unable to tell which
 * of the two screens they are on. Sorting by specificity makes the deepest
 * matching link authoritative and its parent merely *open*.
 *
 * Routes with no navigation entry of their own — `/dashboard/transfers/new`, a
 * purchase detail page — resolve to their nearest ancestor, so the sidebar never
 * goes blank while the user is somewhere real.
 */
export function resolveActiveNav(pathname: string): ActiveNav {
  const matches = ALL_LINKS.filter(link => covers(link.href, pathname)).sort((a, b) => b.href.length - a.href.length);
  const best = matches[0];
  if (!best) return { href: null, parentHref: null };
  return { href: best.href, parentHref: best.parentHref };
}

/**
 * Whether a section should render expanded.
 *
 * Open when it holds the active page, so arriving on a child screen shows the
 * user where they are without a click. The component keeps its own state on top
 * of this for sections the user opens by hand.
 */
export function isSectionOpen(item: NavItem, active: ActiveNav) {
  if (!item.children?.length) return false;
  return active.parentHref === item.href || active.href === item.href;
}

/**
 * The sibling screens belonging to the section that contains `pathname`.
 *
 * Powers the sub-navigation drawn at the top of a section's pages, which is how
 * secondary features stay discoverable in the two situations the sidebar cannot
 * help with: someone browsing with the rail collapsed to icons, and someone who
 * arrived on a detail page from a link and never saw the sidebar expand.
 *
 * Returns an empty array for a section with no second tier, so a page can render
 * this unconditionally and get nothing when there is nothing to show.
 */
export function sectionChildren(pathname: string): NavChild[] {
  const active = resolveActiveNav(pathname);
  const sectionHref = active.parentHref ?? active.href;
  if (!sectionHref) return [];

  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (item.href === sectionHref && item.children?.length) return item.children;
    }
  }
  return [];
}
