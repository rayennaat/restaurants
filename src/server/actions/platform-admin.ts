"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { organizations, ownerOnboardingTokens, platformAuditLogs } from "@/db/schema";
import { createOwnerOnboardingToken, hashOwnerOnboardingToken, normalizeOnboardingEmail, ownerOnboardingExpiry } from "@/lib/owner-onboarding";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { requirePlatformAdminAction } from "@/server/platform-admin";

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

function siteOrigin() {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
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
    return actionOk({ url: `${siteOrigin()}/onboarding/${token}`, email, expiresAt: expiresAt.toISOString() });
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
      if (!revoked) throw new Error("Invitation is no longer pending.");
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
      if (!current) throw new Error("Organization not found.");
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
