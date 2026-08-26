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
import { listAdminAuthUsers, getAdminAuthUserById, type AdminAuthUser } from "@/lib/supabase/admin";
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

export type PlatformUserRow = {
  userId: string;
  email: string | null;
  emailConfirmedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date | null;
  status: string;
  organizationId: string | null;
  organizationName: string | null;
  role: string | null;
};

function toValidDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function authMap(users: AdminAuthUser[]) {
  return new Map(users.map(user => [user.id, user]));
}

function matchesUserSearch(user: AdminAuthUser, term: string) {
  const normalized = term.toLowerCase();
  return user.id.toLowerCase().includes(normalized) || (user.email ?? "").toLowerCase().includes(normalized);
}

export async function listPlatformOrganizations(search = ""): Promise<PlatformOrganizationRow[]> {
  await requirePlatformAdmin();
  const term = search.trim();
  const where = term ? or(ilike(organizations.name, `%${term}%`), ilike(organizations.slug, `%${term}%`)) : undefined;
  const db = getDb();
  const [liveUsers, rows, memberships] = await Promise.all([
    listAdminAuthUsers(),
    db
      .select({
        id: organizations.id,
        name: organizations.name,
        plan: organizations.plan,
        status: organizations.status,
        createdAt: organizations.createdAt,
        locations: sql<number>`count(distinct ${locations.id})`,
        lastActivityAt: sql<Date | null>`greatest(max(${purchases.createdAt}), max(${sales.createdAt}), max(${organizationMembers.createdAt}), max(${organizations.updatedAt}))`,
      })
      .from(organizations)
      .leftJoin(organizationMembers, eq(organizationMembers.organizationId, organizations.id))
      .leftJoin(locations, eq(locations.organizationId, organizations.id))
      .leftJoin(purchases, eq(purchases.organizationId, organizations.id))
      .leftJoin(sales, eq(sales.organizationId, organizations.id))
      .where(where)
      .groupBy(organizations.id)
      .orderBy(desc(organizations.createdAt)),
    db.select({ organizationId: organizationMembers.organizationId, userId: organizationMembers.userId, role: organizationMembers.role }).from(organizationMembers),
  ]);

  const live = authMap(liveUsers);
  const membersByOrg = new Map<string, { userId: string; role: string }[]>();
  for (const membership of memberships) {
    if (!live.has(membership.userId)) continue;
    const list = membersByOrg.get(membership.organizationId) ?? [];
    list.push({ userId: membership.userId, role: membership.role });
    membersByOrg.set(membership.organizationId, list);
  }

  return rows.map(row => {
    const orgMembers = membersByOrg.get(row.id) ?? [];
    const owner = orgMembers.find(member => member.role === "owner");
    return {
      ...row,
      ownerEmail: owner ? live.get(owner.userId)?.email ?? "Unknown owner" : "Unknown owner",
      users: new Set(orgMembers.map(member => member.userId)).size,
      locations: Number(row.locations),
      lastActivityAt: toValidDate(row.lastActivityAt),
    };
  });
}

export async function getPlatformOrganization(id: string) {
  await requirePlatformAdmin();
  const db = getDb();
  const [organization] = await db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
  if (!organization) return null;

  const [liveUsers, memberRows, locationRows, counts, invitations] = await Promise.all([
    listAdminAuthUsers(),
    db.select({ userId: organizationMembers.userId, role: organizationMembers.role, joinedAt: organizationMembers.createdAt })
      .from(organizationMembers)
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

  const live = authMap(liveUsers);
  const members = memberRows
    .map(member => ({ ...member, email: live.get(member.userId)?.email ?? null }))
    .filter(member => live.has(member.userId));

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
  const [liveUsers, summary, recentOrganizations, pendingInvitations, recentAudit, locationCount] = await Promise.all([
    listAdminAuthUsers(),
    db.select({
      organizations: sql<number>`count(*)`,
      activePilots: sql<number>`count(*) filter (where ${organizations.status} = 'pilot')`,
    }).from(organizations),
    db.select({ id: organizations.id, name: organizations.name, status: organizations.status, plan: organizations.plan, createdAt: organizations.createdAt }).from(organizations).orderBy(desc(organizations.createdAt)).limit(8),
    db.select({ count: sql<number>`count(*)` }).from(ownerOnboardingTokens).where(eq(ownerOnboardingTokens.status, "pending")),
    db.select({ id: platformAuditLogs.id, action: platformAuditLogs.action, organizationId: platformAuditLogs.organizationId, entityId: platformAuditLogs.entityId, metadata: platformAuditLogs.metadata, createdAt: platformAuditLogs.createdAt }).from(platformAuditLogs).orderBy(desc(platformAuditLogs.createdAt)).limit(12),
    db.select({ count: sql<number>`count(*)` }).from(locations),
  ]);
  return {
    organizations: Number(summary[0]?.organizations ?? 0),
    activePilots: Number(summary[0]?.activePilots ?? 0),
    users: liveUsers.length,
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

export async function listPlatformUsers(search = ""): Promise<PlatformUserRow[]> {
  await requirePlatformAdmin();
  const term = search.trim();
  const db = getDb();
  const [liveUsers, profiles, memberships] = await Promise.all([
    listAdminAuthUsers(),
    db.select({ userId: userProfiles.userId, status: userProfiles.status }).from(userProfiles),
    db
      .select({ userId: organizationMembers.userId, organizationId: organizationMembers.organizationId, organizationName: organizations.name, role: organizationMembers.role })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId)),
  ]);
  const statusByUser = new Map(profiles.map(profile => [profile.userId, profile.status]));
  const membershipsByUser = new Map<string, { userId: string; organizationId: string; organizationName: string; role: string }[]>();
  for (const membership of memberships) {
    const list = membershipsByUser.get(membership.userId) ?? [];
    list.push(membership);
    membershipsByUser.set(membership.userId, list);
  }

  const filteredUsers = term ? liveUsers.filter(user => matchesUserSearch(user, term)) : liveUsers;
  return filteredUsers.flatMap<PlatformUserRow>(user => {
    const userMemberships = membershipsByUser.get(user.id) ?? [];
    const base = {
      userId: user.id,
      email: user.email,
      emailConfirmedAt: user.emailConfirmedAt,
      lastSeenAt: user.lastSeenAt,
      createdAt: user.createdAt,
      status: statusByUser.get(user.id) ?? "active",
    };
    if (!userMemberships.length) return [{ ...base, organizationId: null, organizationName: null, role: null }];
    return userMemberships.map(membership => ({ ...base, organizationId: membership.organizationId, organizationName: membership.organizationName, role: membership.role }));
  });
}

export async function getPlatformUser(userId: string) {
  await requirePlatformAdmin();
  const db = getDb();
  const [user, profile, memberships] = await Promise.all([
    getAdminAuthUserById(userId),
    db.select({ status: userProfiles.status }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1),
    db
      .select({ organizationId: organizationMembers.organizationId, organizationName: organizations.name, role: organizationMembers.role, joinedAt: organizationMembers.createdAt })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, userId))
      .orderBy(asc(organizationMembers.createdAt)),
  ]);
  if (!user) return null;
  return { user: { ...user, userId: user.id, status: profile[0]?.status ?? "active" }, memberships };
}

export async function listPlatformAuditLogs() {
  await requirePlatformAdmin();
  return getDb().select().from(platformAuditLogs).orderBy(desc(platformAuditLogs.createdAt)).limit(200);
}
