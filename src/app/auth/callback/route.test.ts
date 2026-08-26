import { afterEach, describe, expect, it, vi } from "vitest";

async function loadCallback(options: { exchangeError?: boolean; userMissing?: boolean } = {}) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://supabase.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.doMock("next/headers", () => ({
    cookies: vi.fn(async () => ({
      getAll: () => [{ name: "sb-code-verifier", value: "verifier" }],
      set: vi.fn(),
    })),
  }));
  vi.doMock("@supabase/ssr", () => ({
    createServerClient: vi.fn((_url: string, _key: string, config: { cookies: { setAll: (values: { name: string; value: string; options?: { path?: string; httpOnly?: boolean } }[]) => void } }) => ({
      auth: {
        exchangeCodeForSession: vi.fn(async () => {
          if (options.exchangeError) return { data: { session: null }, error: new Error("bad verifier") };
          config.cookies.setAll([{ name: "sb-access-token", value: "access-value", options: { path: "/", httpOnly: true } }]);
          return { data: { session: { access_token: "redacted" } }, error: null };
        }),
        getUser: vi.fn(async () => ({
          data: { user: options.userMissing ? null : { id: "user-123", email: "owner@example.com" } },
          error: options.userMissing ? new Error("missing user") : null,
        })),
      },
    })),
  }));
  vi.doMock("@/server/actions/auth", () => ({ resolvePostAuthRoute: vi.fn(async () => "/onboarding") }));
  return import("./route");
}

describe("auth callback owner onboarding verification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("exchanges the confirmation code, sets auth cookies and redirects to the exact owner token", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { GET } = await loadCallback();
    const response = await GET(new Request("https://yield.test/auth/callback?code=confirmation-code&next=%2Fonboarding%2Fowner-token"));

    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get("location")).toBe("https://yield.test/onboarding/owner-token");
    expect(response.headers.get("location")).not.toBe("https://yield.test/onboarding");
    expect(response.headers.get("set-cookie")).toContain("sb-access-token=access-value");
  });

  it("shows an explicit verification-session error when code exchange fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await loadCallback({ exchangeError: true });
    const response = await GET(new Request("https://yield.test/auth/callback?code=bad-code&next=%2Fonboarding%2Fowner-token"));

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.text()).resolves.toContain("Email verification session could not be completed");
  });
});
