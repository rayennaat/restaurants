import { afterEach, describe, expect, it, vi } from "vitest";

async function loadAuthAction() {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.yield.website");
  const signUp = vi.fn(async () => ({ data: { user: { email_confirmed_at: null } }, error: null }));
  const resetPasswordForEmail = vi.fn(async () => ({ error: null }));
  vi.doMock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ auth: { signUp, resetPasswordForEmail } })) }));
  vi.doMock("@/server/queries/owner-onboarding", () => ({ checkOwnerOnboardingToken: vi.fn(async () => ({ preview: { id: "token-id" }, rejection: null })) }));
  vi.doMock("@/server/queries/team", () => ({ findInvitationByTokenHash: vi.fn(async () => null) }));
  vi.doMock("@/server/tenant", () => ({ getTenantContext: vi.fn(async () => null) }));
  vi.doMock("@/server/platform-admin", () => ({ getPlatformAdmin: vi.fn(async () => null) }));
  const mod = await import("./actions/auth");
  return { ...mod, signUp, resetPasswordForEmail };
}

describe("auth action redirect URLs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("uses NEXT_PUBLIC_APP_URL for owner signup emailRedirectTo", async () => {
    const { registerWithAuthorization, signUp } = await loadAuthAction();
    const token = "OWNER/TOKEN+VALUE";
    const result = await registerWithAuthorization({ email: "owner@example.com", password: "password123", token, kind: "owner" });

    expect(result.ok).toBe(true);
    expect(signUp).toHaveBeenCalledWith(expect.objectContaining({
      email: "owner@example.com",
      options: {
        emailRedirectTo: "https://app.yield.website/auth/callback?next=%2Fonboarding%2FOWNER%252FTOKEN%252BVALUE",
      },
    }));
  });

  it("uses NEXT_PUBLIC_APP_URL for password reset redirects", async () => {
    const { requestPasswordReset, resetPasswordForEmail } = await loadAuthAction();
    const result = await requestPasswordReset("owner@example.com");

    expect(result.ok).toBe(true);
    expect(resetPasswordForEmail).toHaveBeenCalledWith("owner@example.com", {
      redirectTo: "https://app.yield.website/auth/callback?next=/reset-password",
    });
  });
});
