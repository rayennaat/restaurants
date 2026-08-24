import { and, asc, eq } from "drizzle-orm";
import { cache } from "react";
import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { locations, organizationMembers, organizations, units } from "@/db/schema";
import { createClient } from "@/lib/supabase/server";
import type { UnitRow } from "@/lib/units";
import { normalizeRole, type MemberRole } from "@/lib/permissions";

/**
 * Authorization policy lives in `lib/permissions` — pure, dependency-free and
 * unit-tested. It is re-exported here so application code keeps importing
 * authorization and tenancy from one module.
 */
export * from "@/lib/permissions";

export type TenantContext = {
  userId: string;
  email: string | null;
  organizationId: string;
  organizationName: string;
  /** Active location. Null only if every location was archived. */
  locationId: string | null;
  role: MemberRole;
  currency: string;
  locale: string;
  timezone: string;
  onboardingCompletedAt: Date | null;
  plan: "pilot" | "starter" | "restaurant" | "multi_location";
  status: "active" | "pilot" | "suspended" | "cancelled";
};

export type TenantState = TenantContext | { needsOnboarding: true; userId: string } | null;

/**
 * Resolves the signed-in user's organization.
 *
 * Returns `null` when nobody is signed in, and `{ needsOnboarding: true }` when
 * the user exists in Supabase Auth but has not created a workspace yet.
 * Cached per request so the many server components on a page share one query.
 */
export const getTenantContext = cache(async (): Promise<TenantState> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const db = getDb();
  const [row] = await db
    .select({
      organizationId: organizationMembers.organizationId,
      locationId: organizationMembers.defaultLocationId,
      role: organizationMembers.role,
      organizationName: organizations.name,
      currency: organizations.currency,
      locale: organizations.locale,
      timezone: organizations.timezone,
      onboardingCompletedAt: organizations.onboardingCompletedAt,
      plan: organizations.plan,
      status: organizations.status,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, user.id))
    .orderBy(asc(organizationMembers.createdAt))
    .limit(1);

  if (!row) return { needsOnboarding: true, userId: user.id };

  let locationId = row.locationId;
  if (!locationId) {
    const [location] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.organizationId, row.organizationId), eq(locations.isActive, true)))
      .orderBy(asc(locations.createdAt))
      .limit(1);
    locationId = location?.id ?? null;
  }

  return {
    userId: user.id,
    email: user.email ?? null,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    locationId,
    role: normalizeRole(row.role),
    currency: row.currency,
    locale: row.locale,
    timezone: row.timezone,
    onboardingCompletedAt: row.onboardingCompletedAt,
    plan: row.plan,
    status: row.status,
  };
});

/**
 * Page/server-action guard. Redirects unauthenticated users to sign-in and
 * users without a workspace to onboarding, so callers always get a real tenant.
 */
export async function requireTenant(): Promise<TenantContext> {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");
  if ("needsOnboarding" in tenant) redirect("/onboarding");
  if (tenant.status === "suspended" || tenant.status === "cancelled") redirect("/workspace-unavailable");
  return tenant;
}

/** Like {@link requireTenant} but also guarantees a location to post stock against. */
export async function requireTenantLocation() {
  const tenant = await requireTenant();
  if (!tenant.locationId) redirect("/dashboard/settings?missing=location");
  return tenant as TenantContext & { locationId: string };
}

/** Org-scoped unit table used by every quantity conversion. */
export const getOrganizationUnits = cache(async (organizationId: string): Promise<UnitRow[]> => {
  const rows = await getDb()
    .select({ code: units.code, name: units.name, dimension: units.dimension, multiplierToBase: units.multiplierToBase, isBase: units.isBase })
    .from(units)
    .where(eq(units.organizationId, organizationId))
    .orderBy(asc(units.dimension), asc(units.multiplierToBase));
  return rows;
});
