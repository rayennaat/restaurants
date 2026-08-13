import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { INVITABLE_ROLES } from "./permissions";

/**
 * Invitation tokens.
 *
 * The raw token exists in exactly one place: the link the inviter copies. What
 * the database stores is its SHA-256 hash, so read access to
 * `organization_invitations` yields nothing that can be redeemed. This mirrors
 * how a password reset token is handled, and for the same reason — the row is
 * a *verifier*, not a credential.
 *
 * SHA-256 without a salt or work factor is deliberate and sufficient here: the
 * token is 256 bits of CSPRNG output, so there is no dictionary to attack and
 * nothing for a slow hash to protect. That reasoning does not transfer to
 * passwords, which are low-entropy and need Argon2/bcrypt.
 */

/** Days a fresh invitation stays redeemable. */
export const INVITATION_TTL_DAYS = 7;

/** 32 bytes of CSPRNG output, URL-safe so it can live in a path segment. */
export function createInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Compares two token hashes without leaking their divergence point through
 * timing. Lookups go through a unique index rather than a scan, so this mostly
 * guards callers that compare a recomputed hash against a fetched one.
 */
export function tokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function invitationExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + INVITATION_TTL_DAYS * 86_400_000);
}

export type InvitationState = { status: string; expiresAt: Date; email: string; role: string };

export type InvitationRejection = "not_found" | "revoked" | "already_accepted" | "expired" | "email_mismatch" | "role_not_invitable";

export const INVITATION_REJECTION_MESSAGES: Record<InvitationRejection, string> = {
  not_found: "This invitation link is not valid.",
  revoked: "This invitation was cancelled. Ask for a new one.",
  already_accepted: "This invitation has already been used.",
  expired: "This invitation has expired. Ask for a new one.",
  email_mismatch: "This invitation was sent to a different email address. Sign in with that address to accept it.",
  role_not_invitable: "This invitation is not valid. Ask an owner or manager to send a new one.",
};

/**
 * Decides whether an invitation may be redeemed by a given signed-in address.
 *
 * Pure, so the ordering of these checks is directly testable. Returning `null`
 * means "redeemable"; anything else is the reason it is not.
 *
 * The email check is what stops a forwarded link from working: holding the URL
 * is not enough, the redeemer must also control the invited mailbox. Supabase
 * has already verified that address at sign-in, so this is a real constraint
 * rather than a self-asserted one.
 *
 * The role check re-asserts at redemption what `inviteEmployeeInput` asserted at
 * creation: a link may only ever grant an invitable role. Ownership moves by
 * explicit promotion under `transfer_ownership`, never by following a URL. It is
 * deliberately redundant — Zod validates the role on the way in and a CHECK
 * constraint refuses `owner` in the database — because this is the one place that
 * turns a *row* into a *membership*, and it should not have to trust how the row
 * got there. A row written by any future path that forgets the rule stops here.
 */
export function checkInvitationRedeemable(
  invitation: InvitationState | null | undefined,
  signedInEmail: string | null,
  now: Date = new Date(),
): InvitationRejection | null {
  if (!invitation) return "not_found";
  if (invitation.status === "revoked") return "revoked";
  if (invitation.status === "accepted") return "already_accepted";
  if (invitation.expiresAt.getTime() <= now.getTime()) return "expired";
  if (!signedInEmail || signedInEmail.trim().toLowerCase() !== invitation.email.trim().toLowerCase()) return "email_mismatch";
  if (!(INVITABLE_ROLES as readonly string[]).includes(invitation.role)) return "role_not_invitable";
  return null;
}
