import { resolveDateRange, toIsoDate, type DateRange } from "@/lib/date-range";
import { resolveMemberLocation, type ResolvedLocation } from "@/server/queries/locations";
import { requireTenant, type TenantContext } from "@/server/tenant";
import type { Scope } from "@/server/queries/analytics";

/**
 * Resolves the shared dashboard/report filters from a page's search params.
 *
 * The organization always comes from the authenticated tenant context, never
 * from the URL. The location *is* read from the URL, so it passes through
 * `resolveMemberLocation`, which enforces two separate things: that the
 * location belongs to this organization, and that this member's role is
 * allowed to see it. An id from another organization — or a sibling location a
 * kitchen user is not assigned to — degrades to what that member may actually
 * view, never to someone else's data.
 */
export type AnalyticsContext = {
  tenant: TenantContext;
  range: DateRange;
  location: ResolvedLocation;
  scope: Scope;
  /** Custom-range bounds echoed back to the filter inputs as YYYY-MM-DD. */
  fromInput: string;
  toInput: string;
};

export type AnalyticsSearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export async function getAnalyticsContext(params: AnalyticsSearchParams): Promise<AnalyticsContext> {
  const tenant = await requireTenant();

  const range = resolveDateRange({ range: first(params.range), from: first(params.from), to: first(params.to) });
  const location = await resolveMemberLocation(tenant, first(params.location));

  return {
    tenant,
    range,
    location,
    scope: { organizationId: tenant.organizationId, locationId: location.id },
    fromInput: toIsoDate(range.from),
    // The stored bound is exclusive; the picker shows the inclusive last day.
    toInput: toIsoDate(new Date(range.to.getTime() - 86_400_000)),
  };
}
