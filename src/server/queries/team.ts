import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { locations, organizationInvitations, organizationMembers, organizations } from "@/db/schema";
import { normalizeRole, type MemberRole } from "@/server/tenant";

/**
 * Team roster and pending invitations.
 *
 * The runtime database role intentionally cannot read Supabase's private auth
 * schema. Membership rows therefore expose stable, nullable identity fallbacks;
 * authorization continues to use the member user id from the session and the
 * organization-scoped membership row.
 *
 * Every query is filtered by `organizationId` from the server-side tenant
 * context. Nothing here accepts an organization from the caller's request.
 */

export type TeamMemberRow = {
  userId: string;
  email: string;
  displayName: string;
  role: MemberRole;
  defaultLocationId: string | null;
  defaultLocationName: string | null;
  joinedAt: Date;
  lastSignInAt: Date | null;
  /** True for the member viewing the page, which the UI uses to disable self-actions. */
  isSelf: boolean;
};

export async function listTeamMembers(organizationId: string, viewerUserId: string): Promise<TeamMemberRow[]> {
  const rows = await getDb()
    .select({
      userId: organizationMembers.userId,
      role: organizationMembers.role,
      defaultLocationId: organizationMembers.defaultLocationId,
      defaultLocationName: locations.name,
      joinedAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .leftJoin(locations, eq(locations.id, organizationMembers.defaultLocationId))
    .where(eq(organizationMembers.organizationId, organizationId))
    .orderBy(asc(organizationMembers.createdAt));

  return rows.map(row => ({
    userId: row.userId,
    email: "",
    displayName: row.userId === viewerUserId ? "You" : "Unknown user",
    role: normalizeRole(row.role),
    defaultLocationId: row.defaultLocationId,
    defaultLocationName: row.defaultLocationName,
    joinedAt: row.joinedAt,
    lastSignInAt: null,
    isSelf: row.userId === viewerUserId,
  }));
}

/** How many owners the organization has — the last one may not be demoted or removed. */
export async function countOwners(organizationId: string): Promise<number> {
  const rows = await getDb()
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.role, "owner")));
  return rows.length;
}

export type PendingInvitationRow = {
  id: string;
  email: string;
  role: MemberRole;
  locationName: string | null;
  invitedByName: string | null;
  expiresAt: Date;
  createdAt: Date;
  /** True once the expiry has passed; the row stays visible so it can be resent. */
  isExpired: boolean;
};

export async function listPendingInvitations(organizationId: string): Promise<PendingInvitationRow[]> {
  const rows = await getDb()
    .select({
      id: organizationInvitations.id,
      email: organizationInvitations.email,
      role: organizationInvitations.role,
      locationName: locations.name,
      expiresAt: organizationInvitations.expiresAt,
      createdAt: organizationInvitations.createdAt,
    })
    .from(organizationInvitations)
    .leftJoin(locations, eq(locations.id, organizationInvitations.defaultLocationId))
    .where(and(eq(organizationInvitations.organizationId, organizationId), eq(organizationInvitations.status, "pending")))
    .orderBy(desc(organizationInvitations.createdAt));

  const now = Date.now();
  return rows.map(row => ({
    id: row.id,
    email: row.email,
    role: normalizeRole(row.role),
    locationName: row.locationName,
    invitedByName: null,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    isExpired: row.expiresAt.getTime() <= now,
  }));
}

/**
 * Live invitations addressed to one email, across all organizations.
 *
 * Deliberately not scoped to an organization: the caller is not yet a member of
 * anything, and the email — already verified by Supabase at sign-in — is the
 * only thing being matched. Returns organization names for display, never
 * tokens; the raw token is unrecoverable by design, so the invitee must use the
 * link they were sent.
 */
export async function listPendingInvitationsForEmail(email: string): Promise<{ organizationName: string }[]> {
  const rows = await getDb()
    .select({ organizationName: organizations.name })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
    .where(and(eq(organizationInvitations.email, email.trim().toLowerCase()), eq(organizationInvitations.status, "pending")));
  return rows;
}

export type InvitationPreview = {
  id: string;
  email: string;
  role: MemberRole;
  status: string;
  expiresAt: Date;
  organizationId: string;
  organizationName: string;
  defaultLocationId: string | null;
};

/**
 * Resolves an invitation by token hash for the acceptance screen.
 *
 * Deliberately unscoped by organization — the token *is* the scope, and the
 * caller is not yet a member of anything. Redeemability is decided by
 * `checkInvitationRedeemable`, never by this function.
 */
export async function findInvitationByTokenHash(tokenHash: string): Promise<InvitationPreview | null> {
  const [row] = await getDb()
    .select({
      id: organizationInvitations.id,
      email: organizationInvitations.email,
      role: organizationInvitations.role,
      status: organizationInvitations.status,
      expiresAt: organizationInvitations.expiresAt,
      organizationId: organizationInvitations.organizationId,
      organizationName: organizations.name,
      defaultLocationId: organizationInvitations.defaultLocationId,
    })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.organizationId))
    .where(eq(organizationInvitations.tokenHash, tokenHash))
    .limit(1);

  if (!row) return null;
  return { ...row, role: normalizeRole(row.role) };
}
