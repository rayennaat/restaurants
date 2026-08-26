"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { organizationMembers, organizations, ownerOnboardingTokens, platformAdmins, platformAuditLogs, userProfiles } from "@/db/schema";
import { createOwnerOnboardingToken, hashOwnerOnboardingToken, normalizeOnboardingEmail, ownerOnboardingExpiry } from "@/lib/owner-onboarding";
import { ActionError, actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { requirePlatformAdminAction } from "@/server/platform-admin";
import { getAppUrl } from "@/lib/app-url";
import { createAdminClient, getAdminAuthUserById, hasAdminServiceRole } from "@/lib/supabase/admin";

const PLANS = ["pilot", "starter", "restaurant", "multi_location"] as const;
const STATUSES = ["active", "pilot", "suspended", "cancelled"] as const;

type Plan = (typeof PLANS)[number];
type Status = (typeof STATUSES)[number];

function isPlan(value: string): value is Plan {
  return (PLANS as readonly string[]).includes(value);
}

function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

function revalidateUserAdminViews(userId?: string) {
  revalidatePath("/admin");
  revalidatePath("/admin/users");
  if (userId) revalidatePath(`/admin/users/${userId}`);
  revalidatePath("/admin/organizations");
}

async function findLiveAuthUser(userId: string) {
  return getAdminAuthUserById(userId);
}

async function assertNotLastOrganizationOwner(userId: string) {
  const db = getDb();
  const ownerMemberships = await db
    .select({ organizationId: organizationMembers.organizationId, organizationName: organizations.name })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.role, "owner")));

  for (const membership of ownerMemberships) {
    const [count] = await db
      .select({ owners: sql<number>`count(*)` })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, membership.organizationId), eq(organizationMembers.role, "owner")));
    if (Number(count?.owners ?? 0) <= 1) {
      throw new ActionError(`Transfer ownership for ${membership.organizationName} before removing this user.`);
    }
  }
}

async function upsertProfileStatus(userId: string, email: string | null, status: "active" | "disabled") {
  await getDb().transaction(async tx => {
    await tx
      .insert(userProfiles)
      .values({ userId, email: (email ?? "").toLowerCase(), status, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userProfiles.userId,
        set: { email: (email ?? "").toLowerCase(), status, updatedAt: new Date() },
      });
  });
}

export async function issuePlatformOwnerInvitation(emailInput: string): Promise<ActionResult<{ url: string; email: string; expiresAt: string }>> {
  try {
    const admin = await requirePlatformAdminAction();
    const email = normalizeOnboardingEmail(emailInput);
    if (!email || !email.includes("@") || email.length > 320) return actionError("Enter a valid owner email address.");

    const token = createOwnerOnboardingToken();
    const expiresAt = ownerOnboardingExpiry();
    const tokenHash = hashOwnerOnboardingToken(token);
    const db = getDb();

    await db.transaction(async tx => {
      await tx.insert(ownerOnboardingTokens).values({ email, tokenHash, expiresAt, status: "pending" });
      await tx.insert(platformAuditLogs).values({
        actorUserId: admin.userId,
        action: "owner_invitation_issued",
        entityId: null,
        metadata: JSON.stringify({ email, expiresAt: expiresAt.toISOString() }),
      });
    });

    revalidatePath("/admin/invitations");
    return actionOk({ url: `${getAppUrl()}/onboarding/${token}`, email, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    return toActionError(error);
  }
}

export async function revokePlatformOwnerInvitation(tokenId: string): Promise<ActionResult> {
  try {
    const admin = await requirePlatformAdminAction();
    if (!tokenId) return actionError("This invitation could not be identified.");
    const db = getDb();
    await db.transaction(async tx => {
      const [revoked] = await tx.update(ownerOnboardingTokens)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(and(eq(ownerOnboardingTokens.id, tokenId), eq(ownerOnboardingTokens.status, "pending")))
        .returning({ id: ownerOnboardingTokens.id });
      if (!revoked) throw new ActionError("Invitation is no longer pending.");
      await tx.insert(platformAuditLogs).values({ actorUserId: admin.userId, action: "owner_invitation_revoked", entityId: tokenId, metadata: null });
    });
    revalidatePath("/admin/invitations");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function updatePlatformOrganization(input: { organizationId: string; plan: string; status: string }): Promise<ActionResult> {
  try {
    const admin = await requirePlatformAdminAction();
    const plan: Plan | null = isPlan(input.plan) ? input.plan : null;
    const status: Status | null = isStatus(input.status) ? input.status : null;
    if (!input.organizationId || !plan || !status) return actionError("Choose a valid plan and organization status.");
    const db = getDb();
    await db.transaction(async tx => {
      const [current] = await tx.select({ plan: organizations.plan, status: organizations.status }).from(organizations).where(eq(organizations.id, input.organizationId)).limit(1);
      if (!current) throw new ActionError("Organization not found.");
      await tx.update(organizations).set({ plan, status, updatedAt: new Date() }).where(eq(organizations.id, input.organizationId));
      if (current.plan !== input.plan) await tx.insert(platformAuditLogs).values({ actorUserId: admin.userId, organizationId: input.organizationId, action: "organization_plan_changed", entityId: input.organizationId, metadata: JSON.stringify({ from: current.plan, to: input.plan }) });
      if (current.status !== input.status) await tx.insert(platformAuditLogs).values({ actorUserId: admin.userId, organizationId: input.organizationId, action: "organization_status_changed", entityId: input.organizationId, metadata: JSON.stringify({ from: current.status, to: input.status }) });
    });
    revalidatePath("/admin");
    revalidatePath("/admin/organizations");
    revalidatePath(`/admin/organizations/${input.organizationId}`);
    revalidatePath("/dashboard", "layout");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function deactivatePlatformUser(userId: string): Promise<ActionResult> {
  try {
    const admin = await requirePlatformAdminAction();
    if (admin.userId === userId) return actionError("You cannot deactivate your own platform account.");
    const user = await findLiveAuthUser(userId);
    if (!user) return actionError("User not found.");
    await assertNotLastOrganizationOwner(userId);
    await upsertProfileStatus(userId, user.email, "disabled");
    await getDb().insert(platformAuditLogs).values({ actorUserId: admin.userId, action: "user_deactivated", entityId: userId, metadata: JSON.stringify({ email: user.email }) });
    revalidateUserAdminViews(userId);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function reactivatePlatformUser(userId: string): Promise<ActionResult> {
  try {
    const admin = await requirePlatformAdminAction();
    const user = await findLiveAuthUser(userId);
    if (!user) return actionError("User not found.");
    await upsertProfileStatus(userId, user.email, "active");
    await getDb().insert(platformAuditLogs).values({ actorUserId: admin.userId, action: "user_reactivated", entityId: userId, metadata: JSON.stringify({ email: user.email }) });
    revalidateUserAdminViews(userId);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function deletePlatformUser(userId: string): Promise<ActionResult> {
  try {
    const admin = await requirePlatformAdminAction();
    if (admin.userId === userId) return actionError("You cannot delete your own platform account.");
    const user = await findLiveAuthUser(userId);
    if (!user) return actionError("User not found.");
    await assertNotLastOrganizationOwner(userId);
    if (!hasAdminServiceRole()) return actionError("A server-only Supabase service-role key is required to delete Auth users.");

    const result = await createAdminClient().auth.admin.deleteUser(userId);
    if (result.error) return actionError(result.error.message);

    await getDb().transaction(async tx => {
      await tx.delete(organizationMembers).where(eq(organizationMembers.userId, userId));
      await tx.delete(platformAdmins).where(eq(platformAdmins.userId, userId));
      await tx.delete(userProfiles).where(eq(userProfiles.userId, userId));
      await tx.insert(platformAuditLogs).values({ actorUserId: admin.userId, action: "user_deleted", entityId: userId, metadata: JSON.stringify({ email: user.email }) });
    });

    revalidateUserAdminViews(userId);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}
