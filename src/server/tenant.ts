import { and, eq } from "drizzle-orm";
import { createClient } from "@/lib/supabase/server";
import { getDb } from "@/db/client";
import { organizationMembers, organizations, locations } from "@/db/schema";
export const DEMO_ORG_ID = "00000000-0000-4000-8000-000000000001";
export const DEMO_LOCATION_ID = "00000000-0000-4000-8000-000000000002";
export async function getTenantContext() {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") return { userId: "demo-user", organizationId: DEMO_ORG_ID, locationId: DEMO_LOCATION_ID, role: "owner" as const, organizationName: "Demo Bistro", currency: "TND" };
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser(); if (!user) return null;
  const db = getDb();
  const [row] = await db.select({ organizationId: organizationMembers.organizationId, locationId: organizationMembers.defaultLocationId, role: organizationMembers.role, organizationName: organizations.name, currency: organizations.currency }).from(organizationMembers).innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId)).where(eq(organizationMembers.userId, user.id)).limit(1);
  if (!row) return { userId: user.id, needsOnboarding: true as const };
  let locationId = row.locationId;
  if (!locationId) { const [location] = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.organizationId, row.organizationId), eq(locations.isActive, true))).limit(1); locationId = location?.id ?? null; }
  return { userId: user.id, organizationId: row.organizationId, locationId, role: row.role, organizationName: row.organizationName, currency: row.currency };
}
