import { describe, expect, it } from "vitest";
import { isSectionOpen, resolveActiveNav, sectionChildren, NAV_SECTIONS, type NavItem } from "@/lib/navigation";

/**
 * The navigation model.
 *
 * Two things are worth pinning here. The first is the active-state rule: it is
 * the only logic in the navigation, and getting it wrong is quietly bad — the
 * sidebar highlights the wrong row and the user loses their sense of place.
 * The second is coverage: this task's brief is explicit that grouping must not
 * hide anything, so the structure is asserted to still reach every screen.
 */

const allItems: NavItem[] = NAV_SECTIONS.flatMap(section => section.items);
const allHrefs = allItems.flatMap(item => [item.href, ...(item.children ?? []).map(child => child.href)]);

describe("resolving the active entry", () => {
  it("matches the overview exactly", () => {
    expect(resolveActiveNav("/dashboard").href).toBe("/dashboard");
  });

  it("does not light up the overview on every other screen", () => {
    // `/dashboard` is a prefix of everything, so a naive startsWith would keep
    // Overview highlighted across the whole product.
    expect(resolveActiveNav("/dashboard/sales").href).not.toBe("/dashboard");
    expect(resolveActiveNav("/dashboard/reports").href).not.toBe("/dashboard");
  });

  it("matches a top-level section", () => {
    expect(resolveActiveNav("/dashboard/waste").href).toBe("/dashboard/waste");
  });

  it("prefers the child over its parent when both match", () => {
    // The subtle case: /dashboard/sales/import is covered by Sales too. Picking
    // the first match would highlight the parent and leave the user unable to
    // tell which of the two screens they are on.
    const active = resolveActiveNav("/dashboard/sales/import");
    expect(active.href).toBe("/dashboard/sales/import");
    expect(active.parentHref).toBe("/dashboard/sales");
  });

  it("distinguishes import history from the importer", () => {
    // `/dashboard/sales/import` and `/dashboard/sales/imports` share a prefix;
    // only longest-match keeps them apart.
    expect(resolveActiveNav("/dashboard/sales/imports").href).toBe("/dashboard/sales/imports");
    expect(resolveActiveNav("/dashboard/sales/imports/abc").href).toBe("/dashboard/sales/imports");
  });

  it("keeps a detail page attached to its section", () => {
    const active = resolveActiveNav("/dashboard/sales/8f14e45f");
    expect(active.href).toBe("/dashboard/sales");
  });

  it("keeps a nested detail page attached to its child entry", () => {
    const active = resolveActiveNav("/dashboard/inventory/counts/abc123");
    expect(active.href).toBe("/dashboard/inventory/counts");
    expect(active.parentHref).toBe("/dashboard/inventory");
  });

  it("resolves a route with no entry of its own to its nearest ancestor", () => {
    // /dashboard/transfers/new has no navigation row; the sidebar must not go
    // blank while the user is somewhere real.
    const active = resolveActiveNav("/dashboard/transfers/new");
    expect(active.href).toBe("/dashboard/transfers");
    expect(active.parentHref).toBe("/dashboard/inventory");
  });

  it("keeps Team and Settings apart despite the shared prefix", () => {
    // Team lives at /dashboard/settings/team, so Settings would otherwise win.
    expect(resolveActiveNav("/dashboard/settings/team").href).toBe("/dashboard/settings/team");
    expect(resolveActiveNav("/dashboard/settings").href).toBe("/dashboard/settings");
  });

  it("returns nothing for a path outside the dashboard", () => {
    expect(resolveActiveNav("/auth/login")).toEqual({ href: null, parentHref: null });
  });

  it("does not match a sibling whose name merely starts the same way", () => {
    // /dashboard/inventory must not activate for /dashboard/inventorything.
    expect(resolveActiveNav("/dashboard/inventorything").href).toBeNull();
  });
});

describe("section disclosure", () => {
  const sales = allItems.find(item => item.href === "/dashboard/sales")!;
  const waste = allItems.find(item => item.href === "/dashboard/waste")!;

  it("opens the section holding the active child", () => {
    expect(isSectionOpen(sales, resolveActiveNav("/dashboard/sales/import"))).toBe(true);
  });

  it("opens the section when the parent itself is active", () => {
    expect(isSectionOpen(sales, resolveActiveNav("/dashboard/sales"))).toBe(true);
  });

  it("leaves unrelated sections closed", () => {
    expect(isSectionOpen(sales, resolveActiveNav("/dashboard/waste"))).toBe(false);
  });

  it("never reports an item without children as open", () => {
    expect(isSectionOpen(waste, resolveActiveNav("/dashboard/waste"))).toBe(false);
  });
});

describe("section sub-navigation", () => {
  const hrefs = (pathname: string) => sectionChildren(pathname).map(child => child.href);

  it("lists the section's screens from the parent page", () => {
    expect(hrefs("/dashboard/inventory")).toEqual([
      "/dashboard/inventory",
      "/dashboard/ingredients",
      "/dashboard/inventory/counts",
      "/dashboard/transfers",
    ]);
  });

  it("lists the same screens from a sibling within the section", () => {
    // Standing on Transfers must still offer Stock counts and Ingredients —
    // this is the discoverability the sidebar disclosure alone would not give
    // someone browsing with the rail collapsed.
    expect(hrefs("/dashboard/transfers")).toEqual(hrefs("/dashboard/inventory"));
    expect(hrefs("/dashboard/sales/import")).toEqual(hrefs("/dashboard/sales"));
  });

  it("lists the section's screens from a detail page inside it", () => {
    expect(hrefs("/dashboard/transfers/new")).toEqual(hrefs("/dashboard/inventory"));
    expect(hrefs("/dashboard/purchases/abc123")).toEqual(hrefs("/dashboard/purchases"));
  });

  it("returns nothing for a section with no second tier", () => {
    // Waste, Recipes and Reports are single screens; the sub-nav must render
    // nothing rather than a lone pointless tab.
    expect(hrefs("/dashboard/waste")).toEqual([]);
    expect(hrefs("/dashboard/reports")).toEqual([]);
    expect(hrefs("/dashboard")).toEqual([]);
  });

  it("returns nothing outside the dashboard", () => {
    expect(hrefs("/auth/login")).toEqual([]);
  });
});

describe("the structure stays discoverable", () => {
  it("keeps the top level short enough to scan", () => {
    // The problem being solved: fifteen equal-weight entries. Anything much
    // above ten and the grouping has stopped doing its job.
    expect(allItems.length).toBeLessThanOrEqual(10);
  });

  it("still reaches every screen the flat sidebar reached", () => {
    // Requirement: grouping must not hide features. Each of these was a
    // top-level entry before and must remain clickable from the sidebar.
    for (const href of [
      "/dashboard",
      "/dashboard/sales",
      "/dashboard/sales/import",
      "/dashboard/ingredients",
      "/dashboard/inventory",
      "/dashboard/inventory/counts",
      "/dashboard/transfers",
      "/dashboard/purchases",
      "/dashboard/suppliers",
      "/dashboard/recipes",
      "/dashboard/menu",
      "/dashboard/waste",
      "/dashboard/reports",
      "/dashboard/settings/team",
      "/dashboard/settings",
    ]) {
      expect(allHrefs, `${href} is no longer reachable from the sidebar`).toContain(href);
    }
  });

  it("gives every link a distinct destination within its own section", () => {
    for (const item of allItems) {
      const childHrefs = (item.children ?? []).map(child => child.href);
      expect(new Set(childHrefs).size, `${item.label} repeats a child link`).toBe(childHrefs.length);
    }
  });

  it("opens each parent onto a real screen of its own", () => {
    // A parent that only expands would be a dead click for anyone who wanted
    // the section's main page.
    for (const item of allItems) {
      expect(item.href.startsWith("/dashboard")).toBe(true);
    }
  });

  it("lists the parent's own page first among its children", () => {
    // So the disclosure reads as "the section, then what is inside it".
    for (const item of allItems) {
      if (!item.children?.length) continue;
      expect(item.children[0].href, `${item.label} should lead with its own page`).toBe(item.href);
    }
  });

  it("gives every entry an icon, so the collapsed rail stays usable", () => {
    for (const item of allItems) {
      expect(item.icon, `${item.label} has no icon`).toBeTruthy();
      for (const child of item.children ?? []) expect(child.icon, `${child.label} has no icon`).toBeTruthy();
    }
  });

  it("labels every entry in restaurant language, not schema language", () => {
    const jargon = /ledger|movement|entity|record set|reconcil|variance|tenant|rls/i;
    for (const href of allHrefs) void href;
    for (const item of allItems) {
      expect(item.label).not.toMatch(jargon);
      for (const child of item.children ?? []) expect(child.label).not.toMatch(jargon);
    }
  });
});
