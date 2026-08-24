import { createHash, randomBytes } from "node:crypto";

export const OWNER_ONBOARDING_TTL_DAYS = 7;

export function createOwnerOnboardingToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOwnerOnboardingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function ownerOnboardingExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + OWNER_ONBOARDING_TTL_DAYS * 86_400_000);
}

export type OwnerOnboardingState = {
  status: string;
  expiresAt: Date;
  email: string;
};

export type OwnerOnboardingRejection = "not_found" | "revoked" | "claimed" | "expired" | "email_mismatch";

export const OWNER_ONBOARDING_REJECTION_MESSAGES: Record<OwnerOnboardingRejection, string> = {
  not_found: "This owner onboarding link is not valid.",
  revoked: "This owner onboarding link was cancelled. Request a new link.",
  claimed: "This owner onboarding link has already been used.",
  expired: "This owner onboarding link has expired. Request a new link.",
  email_mismatch: "This owner onboarding link was issued for a different email address.",
};

export function checkOwnerOnboardingRedeemable(
  onboarding: OwnerOnboardingState | null | undefined,
  signedInEmail: string | null,
  now: Date = new Date(),
): OwnerOnboardingRejection | null {
  if (!onboarding) return "not_found";
  if (onboarding.status === "revoked") return "revoked";
  if (onboarding.status === "claimed") return "claimed";
  if (onboarding.expiresAt.getTime() <= now.getTime()) return "expired";
  if (!signedInEmail || signedInEmail.trim().toLowerCase() !== onboarding.email.trim().toLowerCase()) return "email_mismatch";
  return null;
}

export function normalizeOnboardingEmail(email: string): string {
  return email.trim().toLowerCase();
}
