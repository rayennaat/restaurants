import { asc, desc, eq, ilike, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  ingredients,
  locations,
  organizationInvitations,
  organizationMembers,
  organizations,
  ownerOnboardingTokens,
  platformAuditLogs,
  purchases,
  sales,
  userProfiles,
} from "@/db/schema";
import { requirePlatformAdmin } from "@/server/platform-admin";

export const PLAN_LABELS = {
  pilot: "Pilot",
  starter: "Starter",
  restaurant: "Restaurant",
  multi_location: "Multi-location",
} as const;

export const STATUS_LABELS = {
  active: "Active",
  pilot: "Pilot",
  suspended: "Suspended",
  cancelled: "Cancelled",
} as const;

export type PlatformOrganizationRow = {
  id: string;
  name: string;
  plan: keyof typeof PLAN_LABELS;
  status: keyof typeof STATUS_LABELS;
  ownerEmail: string;
  users: number;
  locations: number;
  createdAt: Date;
  lastActivityAt: Date | null;
};

export async function listPlatformOrganizations(search = ""): Promise<PlatformOrganizationRow[]> {
  await requirePlatformAdmin();
  const term = search.trim();
  const where = term ? or(ilike(organizations.name, `%${term}%`), ilike(organizations.slug, `%${term}%`)) : undefined;
  const rows = await getDb()
    .select({
      id: organizations.id,
      name: organizations.name,
      plan: organizations.plan,
      status: organizations.status,
      createdAt: organizations.createdAt,
      ownerEmail: sql<string>`coalesce(max(case when ${organizationMembers.role} = 'owner' then ${userProfiles.email} end), 'Unknown owner')`,
      users: sql<number>`count(distinct ${organizationMembers.userId})`,
      locations: sql<number>`count(distinct ${locations.id})`,
      lastActivityAt: sql<Date | null>`greatest(max(${purchases.createdAt}), max(${sales.createdAt}), max(${organizationMembers.createdAt}), max(${organizations.updatedAt}))`,
    })
    .from(organizations)
    .leftJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
    .leftJoin(userProfiles, eq(userProfiles.userId, organizationMembers.userId))
    .leftJoin(locations, eq(locations.organizationId, organizations.id))
    .leftJoin(purchases, eq(purchases.organizationId, organizations.id))
    .leftJoin(sales, eq(sales.organizationId, organizations.id))
    .where(where)
    .groupBy(organizations.id)
    .orderBy(desc(organizations.createdAt));
  return rows.map(row => ({
    ...row,
    users: Number(row.users),
    locations: Number(row.locations),
    lastActivityAt: toValidDate(row.lastActivityAt),
  }));
}

function toValidDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function getPlatformOrganization(id: string) {
  await requirePlatformAdmin();
  const db = getDb();
  const [organization] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  if (!organization) return null;

  const [members, locationRows, counts, invitations] = await Promise.all([
    db.select({ userId: organizationMembers.userId, email: userProfiles.email, role: organizationMembers.role, joinedAt: organizationMembers.createdAt })
      .from(organizationMembers)
      .leftJoin(userProfiles, eq(userProfiles.userId, organizationMembers.userId))
      .where(eq(organizationMembers.organizationId, id))
      .orderBy(asc(organizationMembers.createdAt)),
    db.select({ id: locations.id, name: locations.name, active: locations.isActive, createdAt: locations.createdAt })
      .from(locations).where(eq(locations.organizationId, id)).orderBy(asc(locations.createdAt)),
    db.select({
      ingredients: sql<number>`count(distinct ${ingredients.id})`,
      purchases: sql<number>`count(distinct ${purchases.id})`,
      sales: sql<number>`count(distinct ${sales.id})`,
    })
      .from(organizations)
      .leftJoin(ingredients, eq(ingredients.organizationId, organizations.id))
      .leftJoin(purchases, eq(purchases.organizationId, organizations.id))
      .leftJoin(sales, eq(sales.organizationId, organizations.id))
      .where(eq(organizations.id, id)),
    db.select({ id: organizationInvitations.id, email: organizationInvitations.email, role: organizationInvitations.role, status: organizationInvitations.status, expiresAt: organizationInvitations.expiresAt, createdAt: organizationInvitations.createdAt })
      .from(organizationInvitations).where(eq(organizationInvitations.organizationId, id)).orderBy(desc(organizationInvitations.createdAt)),
  ]);

  return {
    organization,
    members,
    locations: locationRows,
    counts: counts[0] ? Object.fromEntries(Object.entries(counts[0]).map(([key, value]) => [key, Number(value)])) : { ingredients: 0, purchases: 0, sales: 0 },
    invitations,
  };
}

export async function getPlatformOverview() {
  await requirePlatformAdmin();
  const db = getDb();
  const [summary, recentOrganizations, pendingInvitations, recentAudit] = await Promise.all([
    db.select({
      organizations: sql<number>`count(*)`,
      activePilots: sql<number>`count(*) filter (where ${organizations.status} = 'pilot')`,
    }).from(organizations),
    db.select({ id: organizations.id, name: organizations.name, status: organizations.status, plan: organizations.plan, createdAt: organizations.createdAt }).from(organizations).orderBy(desc(organizations.createdAt)).limit(8),
    db.select({ count: sql<number>`count(*)` }).from(ownerOnboardingTokens).where(eq(ownerOnboardingTokens.status, "pending")),
    db.select({ id: platformAuditLogs.id, action: platformAuditLogs.action, organizationId: platformAuditLogs.organizationId, entityId: platformAuditLogs.entityId, metadata: platformAuditLogs.metadata, createdAt: platformAuditLogs.createdAt }).from(platformAuditLogs).orderBy(desc(platformAuditLogs.createdAt)).limit(12),
  ]);
  const [users, locationCount] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(userProfiles),
    db.select({ count: sql<number>`count(*)` }).from(locations),
  ]);
  return {
    organizations: Number(summary[0]?.organizations ?? 0),
    activePilots: Number(summary[0]?.activePilots ?? 0),
    users: Number(users[0]?.count ?? 0),
    locations: Number(locationCount[0]?.count ?? 0),
    pendingOwnerInvitations: Number(pendingInvitations[0]?.count ?? 0),
    recentOrganizations,
    recentAudit,
  };
}

export async function listPlatformOwnerInvitations() {
  await requirePlatformAdmin();
  const rows = await getDb()
    .select({
      id: ownerOnboardingTokens.id,
      email: ownerOnboardingTokens.email,
      status: ownerOnboardingTokens.status,
      expiresAt: ownerOnboardingTokens.expiresAt,
      claimedAt: ownerOnboardingTokens.claimedAt,
      createdAt: ownerOnboardingTokens.createdAt,
    })
    .from(ownerOnboardingTokens)
    .orderBy(desc(ownerOnboardingTokens.createdAt));

  const now = Date.now();
  return rows.map(row => ({
    ...row,
    displayStatus: row.status === "pending" && row.expiresAt.getTime() <= now ? "expired" as const : row.status,
  }));
}

export async function listPlatformUsers(search = "") {
  await requirePlatformAdmin();
  const term = search.trim();
  const profileWhere = term ? or(ilike(userProfiles.email, `%${term}%`), ilike(userProfiles.userId, `%${term}%`)) : undefined;
  const rows = await getDb()
    .select({ userId: userProfiles.userId, email: userProfiles.email, emailConfirmedAt: userProfiles.emailConfirmedAt, lastSeenAt: userProfiles.lastSeenAt, status: userProfiles.status, organizationId: organizationMembers.organizationId, organizationName: organizations.name, role: organizationMembers.role })
    .from(userProfiles)
    .leftJoin(organizationMembers, eq(organizationMembers.userId, userProfiles.userId))
    .leftJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(profileWhere)
    .orderBy(desc(userProfiles.createdAt));
  return rows;
}

export async function listPlatformAuditLogs() {
  await requirePlatformAdmin();
  return getDb().select().from(platformAuditLogs).orderBy(desc(platformAuditLogs.createdAt)).limit(200);
}
