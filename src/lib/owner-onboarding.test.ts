import { describe, expect, it } from "vitest";
import {
  checkOwnerOnboardingRedeemable,
  createOwnerOnboardingToken,
  hashOwnerOnboardingToken,
  normalizeOnboardingEmail,
  ownerOnboardingExpiry,
  OWNER_ONBOARDING_REJECTION_MESSAGES,
  OWNER_ONBOARDING_TTL_DAYS,
} from "./owner-onboarding";

describe("owner onboarding tokens", () => {
  it("generates high-entropy URL-safe tokens and deterministic hashes", () => {
    const first = createOwnerOnboardingToken();
    const second = createOwnerOnboardingToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.length).toBeGreaterThanOrEqual(40);
    expect(second).not.toBe(first);
    expect(hashOwnerOnboardingToken(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashOwnerOnboardingToken(first)).toBe(hashOwnerOnboardingToken(first));
    expect(hashOwnerOnboardingToken(first)).not.toBe(hashOwnerOnboardingToken(second));
  });

  it("expires exactly seven days after issuance", () => {
    const issuedAt = new Date("2026-01-01T12:00:00.000Z");
    const expiry = ownerOnboardingExpiry(issuedAt);

    expect(OWNER_ONBOARDING_TTL_DAYS).toBe(7);
    expect(expiry.toISOString()).toBe("2026-01-08T12:00:00.000Z");
  });

  describe("redeemability", () => {
    const issuedAt = new Date("2026-01-01T00:00:00.000Z");
    const base = {
      status: "pending",
      email: "owner@example.com",
      expiresAt: ownerOnboardingExpiry(issuedAt),
    };

    it("accepts a pending token for the intended email", () => {
      expect(
        checkOwnerOnboardingRedeemable(
          base,
          "  OWNER@Example.com ",
          new Date("2026-01-02T00:00:00.000Z"),
        ),
      ).toBeNull();
    });

    it("normalizes owner email input", () => {
      expect(normalizeOnboardingEmail("  OWNER@Example.COM ")).toBe("owner@example.com");
    });

    it("rejects missing, revoked, and claimed tokens", () => {
      const now = new Date("2026-01-02T00:00:00.000Z");

      expect(checkOwnerOnboardingRedeemable(null, "owner@example.com", now)).toBe("not_found");
      expect(checkOwnerOnboardingRedeemable({ ...base, status: "revoked" }, "owner@example.com", now)).toBe("revoked");
      expect(checkOwnerOnboardingRedeemable({ ...base, status: "claimed" }, "owner@example.com", now)).toBe("claimed");
    });

    it("rejects expired tokens including the exact expiry boundary", () => {
      expect(checkOwnerOnboardingRedeemable(base, "owner@example.com", base.expiresAt)).toBe("expired");
      expect(
        checkOwnerOnboardingRedeemable(
          base,
          "owner@example.com",
          new Date(base.expiresAt.getTime() + 1),
        ),
      ).toBe("expired");
    });

    it("rejects a forwarded token and a signed-out redeemer", () => {
      const now = new Date("2026-01-02T00:00:00.000Z");

      expect(checkOwnerOnboardingRedeemable(base, "other@example.com", now)).toBe("email_mismatch");
      expect(checkOwnerOnboardingRedeemable(base, null, now)).toBe("email_mismatch");
    });

    it("provides a user-facing message for every rejection reason", () => {
      for (const reason of ["not_found", "revoked", "claimed", "expired", "email_mismatch"] as const) {
        expect(OWNER_ONBOARDING_REJECTION_MESSAGES[reason]).toBeTruthy();
      }
    });
  });
});
