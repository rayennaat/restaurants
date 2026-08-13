"use server";

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { authUsers } from "@/db/auth-schema";
import { locations, organizationInvitations, organizationMembers } from "@/db/schema";
import { createClient } from "@/lib/supabase/server";
import {
  checkInvitationRedeemable,
  createInvitationToken,
  hashInvitationToken,
  invitationExpiry,
  INVITATION_REJECTION_MESSAGES,
} from "@/lib/invitations";
import { changeMemberLocationInput, changeMemberRoleInput, inviteEmployeeInput } from "@/lib/validation";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";
import { recordAudit } from "@/server/audit";
import { assertNotSelf, normalizeRole, requirePermission, requireTenant, type InvitableRole, type MemberRole } from "@/server/tenant";
import { ActionError } from "@/lib/action-error";

/**
 * Team and invitation mutations.
 *
 * Every function here re-derives the organization and role from the
 * authenticated session via `requireTenant()`. Nothing trusts an
 * organization id, user id, or role arriving from the client: the only client
 * input that matters is *which* member or invitation is being acted on, and
 * each of those is re-scoped to the caller's organization in the WHERE clause.
 *
 * Three rules are enforced in every path that could otherwise escalate:
 *   1. Only an owner may grant or revoke the `owner` role.
 *   2. Nobody may act on their own membership.
 *   3. The last owner may not be demoted or removed.
 */

/** Confirms a location belongs to the caller's organization before it is stored. */
async function assertLocationInOrg(organizationId: string, locationId: string | undefined | null) {
  if (!locationId) return;
  const [row] = await getDb()
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.organizationId, organizationId)))
    .limit(1);
  if (!row) throw new ActionError("That location does not belong to this workspace.");
}

/**
 * Creates a pending invitation and returns the one-time link to share.
 *
 * The raw token is returned to the caller and never stored; only its hash is
 * persisted. If the link is lost, the invitation is resent (which rotates the
 * token) rather than recovered.
 */
export async function inviteEmployee(input: unknown): Promise<ActionResult<{ token: string; email: string; invitationId: string }>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_team");

    const values = inviteEmployeeInput.parse(input);
    await assertLocationInOrg(tenant.organizationId, values.defaultLocationId);

    const db = getDb();

    // Someone who is already a member cannot be invited again. Matched on the
    // live auth email rather than a stored copy.
    const existing = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .innerJoin(authUsers, eq(authUsers.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.organizationId, tenant.organizationId), eq(authUsers.email, values.email)))
      .limit(1);
    if (existing.length) return actionError("That person is already on your team.", { email: "Already a member." });

    const token = createInvitationToken();
    const tokenHash = hashInvitationToken(token);

    const invitationId = await db.transaction(async tx => {
      // Supersede any live invitation for this address so the partial unique
      // index cannot reject a legitimate re-invite.
      await tx
        .update(organizationInvitations)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(
          and(
            eq(organizationInvitations.organizationId, tenant.organizationId),
            eq(organizationInvitations.email, values.email),
            eq(organizationInvitations.status, "pending"),
          ),
        );

      const [created] = await tx
        .insert(organizationInvitations)
        .values({
          organizationId: tenant.organizationId,
          email: values.email,
          role: values.role,
          defaultLocationId: values.defaultLocationId ?? null,
          invitedBy: tenant.userId,
          tokenHash,
          status: "pending",
          expiresAt: invitationExpiry(),
        })
        .returning({ id: organizationInvitations.id });

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "employee_invited",
          entityType: "invitation",
          entityId: created.id,
          metadata: { email: values.email, role: values.role },
        },
        tx,
      );

      return created.id;
    });

    revalidatePath("/dashboard/settings/team");
    return actionOk({ token, email: values.email, invitationId });
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Redeems an invitation for the signed-in user.
 *
 * The role comes from the invitation row, never from the request — the invitee
 * proves possession of the link, and the inviter decided what it grants. What
 * the row may grant is re-checked by `checkInvitationRedeemable`, so a row is
 * never trusted to name a role an invitation is not allowed to hand out.
 *
 * Every write that consumes the invitation is conditional on it still being
 * `pending`. That is what makes redemption single-use under concurrency: two
 * requests carrying the same token produce one membership and one audit entry,
 * and the loser is told the link has already been used rather than quietly
 * writing a second one.
 */
export async function acceptInvitation(token: string): Promise<ActionResult<{ organizationId: string }>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return actionError("Sign in to accept this invitation.");
    if (!user.email_confirmed_at) return actionError("Verify your email address before accepting this invitation.");

    const db = getDb();
    const tokenHash = hashInvitationToken(token);

    const [invitation] = await db
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.tokenHash, tokenHash))
      .limit(1);

    const rejection = checkInvitationRedeemable(invitation ?? null, user.email ?? null);
    if (rejection) return actionError(INVITATION_REJECTION_MESSAGES[rejection]);

    // Redeemability established that the stored role is one an invitation may
    // grant, so this narrowing cannot widen what the link is worth.
    const grantedRole = invitation.role as InvitableRole;

    const claimed = await db.transaction(async tx => {
      /**
       * Claim the invitation first, and only proceed if this request is the one
       * that moved it out of `pending`.
       *
       * The redeemability check above ran outside the transaction, so on its own
       * it cannot stop two concurrent redemptions — or a replayed request —
       * from both passing it. The membership primary key would reject the second
       * insert, but only after it had written a second audit entry claiming the
       * invitation was accepted twice.
       */
      const [consumed] = await tx
        .update(organizationInvitations)
        .set({ status: "accepted", acceptedAt: new Date(), acceptedBy: user.id, updatedAt: new Date() })
        .where(and(eq(organizationInvitations.id, invitation.id), eq(organizationInvitations.status, "pending")))
        .returning({ id: organizationInvitations.id });
      if (!consumed) return false;

      const [member] = await tx
        .select({ userId: organizationMembers.userId })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, invitation.organizationId), eq(organizationMembers.userId, user.id)))
        .limit(1);

      if (!member) {
        await tx.insert(organizationMembers).values({
          organizationId: invitation.organizationId,
          userId: user.id,
          role: grantedRole,
          defaultLocationId: invitation.defaultLocationId,
        });
      }

      await recordAudit(
        {
          organizationId: invitation.organizationId,
          userId: user.id,
          action: "invitation_accepted",
          entityType: "member",
          entityId: invitation.id,
          metadata: { email: invitation.email, role: grantedRole },
        },
        tx,
      );
      return true;
    });

    if (!claimed) return actionError(INVITATION_REJECTION_MESSAGES.already_accepted);

    revalidatePath("/", "layout");
    return actionOk({ organizationId: invitation.organizationId });
  } catch (error) {
    return toActionError(error);
  }
}

/** Rotates the token on a pending invitation and returns a fresh link. */
export async function resendInvitation(invitationId: string): Promise<ActionResult<{ token: string; email: string }>> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_team");

    const token = createInvitationToken();
    const updated = await getDb().transaction(async tx => {
      const [row] = await tx
        .update(organizationInvitations)
        .set({ tokenHash: hashInvitationToken(token), expiresAt: invitationExpiry(), status: "pending", updatedAt: new Date() })
        .where(
          and(
            eq(organizationInvitations.id, invitationId),
            eq(organizationInvitations.organizationId, tenant.organizationId),
            eq(organizationInvitations.status, "pending"),
          ),
        )
        .returning({ email: organizationInvitations.email });

      if (!row) return null;

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "invitation_resent",
          entityType: "invitation",
          entityId: invitationId,
          metadata: { email: row.email },
        },
        tx,
      );
      return row;
    });

    if (!updated) return actionError("That invitation is no longer pending.");

    revalidatePath("/dashboard/settings/team");
    return actionOk({ token, email: updated.email });
  } catch (error) {
    return toActionError(error);
  }
}

export async function revokeInvitation(invitationId: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_team");

    const updated = await getDb().transaction(async tx => {
      const [row] = await tx
        .update(organizationInvitations)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(
          and(
            eq(organizationInvitations.id, invitationId),
            eq(organizationInvitations.organizationId, tenant.organizationId),
            eq(organizationInvitations.status, "pending"),
          ),
        )
        .returning({ email: organizationInvitations.email });

      if (!row) return null;

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "invitation_revoked",
          entityType: "invitation",
          entityId: invitationId,
          metadata: { email: row.email },
        },
        tx,
      );
      return row;
    });

    if (!updated) return actionError("That invitation is no longer pending.");

    revalidatePath("/dashboard/settings/team");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Changes a member's role.
 *
 * Granting or removing `owner` additionally requires `transfer_ownership`,
 * which only an owner holds — so a manager cannot promote anyone (including a
 * confederate) to owner, and cannot demote the owner above them.
 */
export async function changeMemberRole(input: unknown): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_team");

    const values = changeMemberRoleInput.parse(input);
    assertNotSelf(tenant.userId, values.userId, "You cannot change your own role.");

    const db = getDb();
    const nextRole = values.role as MemberRole;

    const changed = await db.transaction(async tx => {
      // Serialize role/removal decisions for this organization. Without this,
      // two owners could concurrently demote each other after both observed two
      // owners, leaving the workspace with nobody able to administer it.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenant.organizationId}, 0))`);

      const [target] = await tx
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, tenant.organizationId), eq(organizationMembers.userId, values.userId)))
        .limit(1);
      if (!target) return "missing" as const;

      const currentRole = normalizeRole(target.role);
      if (currentRole === nextRole) return "unchanged" as const;

      // Ownership moves in either direction only under `transfer_ownership`.
      if (nextRole === "owner" || currentRole === "owner") {
        requirePermission(tenant.role, "transfer_ownership");
      }

      if (currentRole === "owner") {
        const owners = await tx
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.organizationId, tenant.organizationId), eq(organizationMembers.role, "owner")));
        if (owners.length <= 1) return "last_owner" as const;
      }

      await tx
        .update(organizationMembers)
        .set({ role: nextRole })
        .where(and(eq(organizationMembers.organizationId, tenant.organizationId), eq(organizationMembers.userId, values.userId)));

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "member_role_changed",
          entityType: "member",
          entityId: values.userId,
          metadata: { from: currentRole, to: nextRole },
        },
        tx,
      );
      return "changed" as const;
    });

    if (changed === "missing") return actionError("That person is not on your team.");
    if (changed === "last_owner") return actionError("This is the only owner. Promote someone else to owner first.");
    if (changed === "unchanged") return actionOk();

    revalidatePath("/dashboard/settings/team");
    revalidatePath("/", "layout");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

export async function changeMemberLocation(input: unknown): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_team");

    const values = changeMemberLocationInput.parse(input);
    await assertLocationInOrg(tenant.organizationId, values.defaultLocationId);

    const updated = await getDb().transaction(async tx => {
      const [row] = await tx
        .update(organizationMembers)
        .set({ defaultLocationId: values.defaultLocationId ?? null })
        .where(and(eq(organizationMembers.organizationId, tenant.organizationId), eq(organizationMembers.userId, values.userId)))
        .returning({ userId: organizationMembers.userId });
      if (!row) return null;

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "member_location_changed",
          entityType: "member",
          entityId: values.userId,
          metadata: { defaultLocationId: values.defaultLocationId ?? null },
        },
        tx,
      );
      return row;
    });
    if (!updated) return actionError("That person is not on your team.");

    revalidatePath("/dashboard/settings/team");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}

/**
 * Removes a member. The person keeps their Supabase account — only the
 * membership that authorizes them inside this organization is deleted.
 */
export async function removeMember(userId: string): Promise<ActionResult> {
  try {
    const tenant = await requireTenant();
    requirePermission(tenant.role, "manage_team");
    assertNotSelf(tenant.userId, userId, "You cannot remove yourself from the workspace.");

    const db = getDb();
    const removed = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenant.organizationId}, 0))`);

      const [target] = await tx
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, tenant.organizationId), eq(organizationMembers.userId, userId)))
        .limit(1);
      if (!target) return "missing" as const;

      const targetRole = normalizeRole(target.role);
      if (targetRole === "owner") {
        requirePermission(tenant.role, "transfer_ownership");
        const owners = await tx
          .select({ userId: organizationMembers.userId })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.organizationId, tenant.organizationId), eq(organizationMembers.role, "owner")));
        if (owners.length <= 1) return "last_owner" as const;
      }

      await tx
        .delete(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, tenant.organizationId), eq(organizationMembers.userId, userId)));

      await recordAudit(
        {
          organizationId: tenant.organizationId,
          userId: tenant.userId,
          action: "member_removed",
          entityType: "member",
          entityId: userId,
          metadata: { role: targetRole },
        },
        tx,
      );
      return "removed" as const;
    });

    if (removed === "missing") return actionError("That person is not on your team.");
    if (removed === "last_owner") return actionError("This is the only owner. Promote someone else to owner first.");

    revalidatePath("/dashboard/settings/team");
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}
