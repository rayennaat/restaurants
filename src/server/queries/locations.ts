import { and, asc, eq } from "drizzle-orm";
import { cache } from "react";
import { getDb } from "@/db/client";
import { locations } from "@/db/schema";
import { ActionError } from "@/lib/action-error";
import { canAccessAllLocations, type MemberRole } from "@/server/tenant";

/**
 * Location scoping for the dashboard and reports.
 *
 * The location arrives from the query string, so it is never trusted: it is
 * checked against the organization's own locations before any metric query sees
 * it. An id belonging to another tenant resolves to "all locations" within this
 * organization rather than leaking a single row of someone else's data.
 */

export type LocationOption = { id: string; name: string; isActive: boolean };

/** Locations belonging to the organization. Cached per request. */
export const listLocationOptions = cache(async (organizationId: string): Promise<LocationOption[]> => {
  return getDb()
    .select({ id: locations.id, name: locations.name, isActive: locations.isActive })
    .from(locations)
    .where(eq(locations.organizationId, organizationId))
    .orderBy(asc(locations.name));
});

export type ResolvedLocation = {
  /** Null means "all locations in this organization". */
  id: string | null;
  name: string;
  options: LocationOption[];
};

/**
 * Validates a client-supplied location id against the tenant.
 *
 * `undefined`, `"all"`, or an id this organization does not own all resolve to
 * the org-wide view.
 */
export async function resolveLocation(organizationId: string, requested: string | undefined): Promise<ResolvedLocation> {
  const options = await listLocationOptions(organizationId);
  if (!requested || requested === "all") return { id: null, name: "All locations", options };

  const match = options.find(option => option.id === requested);
  if (!match) return { id: null, name: "All locations", options };
  return { id: match.id, name: match.name, options };
}

/** Direct ownership check, for callers that only need a boolean. */
export async function ownsLocation(organizationId: string, locationId: string) {
  const [row] = await getDb()
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)))
    .limit(1);
  return Boolean(row);
}

/**
 * Asserts a member may *write* against a location, throwing if not.
 *
 * Two separate questions, in the order that matters:
 *   1. Does this location belong to the caller's organization? An id from
 *      another tenant fails here, before anything is written.
 *   2. May this member use it? Owners, managers and accountants span the
 *      organization; inventory and kitchen staff are pinned to their
 *      `defaultLocationId`, so a payload naming a sibling branch is refused
 *      rather than quietly redirected.
 *
 * This is the write-side counterpart to {@link resolveMemberLocation}, which
 * answers the same question for *reads* by narrowing to what the member may see.
 * It lives here, beside both, because every mutation that carries a location —
 * purchases, waste, sales, imports, counts, transfers — has to ask it, and four
 * copies of the rule were four chances for one of them to be forgotten. That is
 * not hypothetical: purchase receiving was the one that had no check at all.
 *
 * `action` completes the sentence "You can only … at your assigned location.",
 * so each caller keeps the wording its users already see.
 */
export async function assertMemberLocation(
  tenant: { organizationId: string; role: MemberRole; locationId: string | null },
  locationId: string,
  action: string,
) {
  if (!(await ownsLocation(tenant.organizationId, locationId))) {
    throw new ActionError("That location does not belong to this workspace.");
  }
  if (!canAccessAllLocations(tenant.role) && tenant.locationId !== locationId) {
    throw new ActionError(`You can only ${action} at your assigned location.`);
  }
}

/**
 * Resolves the location a *member* is allowed to work in.
 *
 * {@link resolveLocation} answers "does this location belong to the
 * organization"; this answers "may this person use it". Owners, managers and
 * accountants work across the whole organization. Inventory and kitchen staff
 * belong to a site: their scope is pinned to `defaultLocationId` no matter what
 * the query string asks for, so editing `?location=` in the URL changes
 * nothing. If such a member has no default location, they see nothing rather
 * than everything — failing closed.
 *
 * The returned `options` list is likewise narrowed, so the filter UI cannot
 * offer a location the member may not select.
 */
export async function resolveMemberLocation(
  tenant: { organizationId: string; role: MemberRole; locationId: string | null },
  requested: string | undefined,
): Promise<ResolvedLocation> {
  const options = await listLocationOptions(tenant.organizationId);

  if (canAccessAllLocations(tenant.role)) {
    return resolveLocation(tenant.organizationId, requested);
  }

  const pinned = options.find(option => option.id === tenant.locationId);
  if (!pinned) {
    return { id: null, name: "No location assigned", options: [] };
  }
  return { id: pinned.id, name: pinned.name, options: [pinned] };
}
