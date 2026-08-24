import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("platform administration boundaries", () => {
  it("gives active platform admins priority after authentication", () => {
    const auth = read("src/server/actions/auth.ts");
    const login = read("src/components/auth/auth-form.tsx");
    const callback = read("src/app/auth/callback/route.ts");
    const onboarding = read("src/app/onboarding/page.tsx");
    const resolverStart = auth.indexOf("export async function resolvePostAuthRoute");
    const resolverEnd = auth.indexOf("export async function registerWithAuthorization");
    const resolver = auth.slice(resolverStart, resolverEnd);

    expect(resolverStart).toBeGreaterThanOrEqual(0);
    expect(resolver).toContain("getPlatformAdmin");
    expect(resolver).toContain('return \"/admin\"');
    expect(resolver.indexOf("const platformAdmin")).toBeLessThan(resolver.indexOf("const tenant"));
    expect(login).toContain("resolvePostAuthRoute");
    expect(callback).toContain("resolvePostAuthRoute");
    expect(onboarding).toContain("getPlatformAdmin");
    expect(onboarding).toContain('redirect(\"/admin\")');
  });

  it("uses an application-owned active allowlist, never restaurant owner role or email", () => {
    const guard = read("src/server/platform-admin.ts");
    expect(guard).toContain("platformAdmins");
    expect(guard).toContain("platformAdmins.active");
    expect(guard).not.toMatch(/organizationMembers|role\s*===\s*[\"']owner[\"']/);
    expect(guard).not.toMatch(/@.*\./);
  });

  it("protects the full admin tree at the layout boundary", () => {
    const layout = read("src/app/admin/layout.tsx");
    expect(layout).toContain("requirePlatformAdmin");
    for (const route of ["src/app/admin/page.tsx", "src/app/admin/organizations/page.tsx", "src/app/admin/invitations/page.tsx", "src/app/admin/users/page.tsx", "src/app/admin/audit/page.tsx"]) {
      expect(read(route)).not.toContain("requireTenant");
    }
  });

  it("keeps platform mutations server-authorized and audited", () => {
    const actions = read("src/server/actions/platform-admin.ts");
    expect(actions).toContain("requirePlatformAdminAction");
    expect(actions).toContain("createOwnerOnboardingToken");
    expect(actions).toContain("hashOwnerOnboardingToken");
    expect(actions).toContain("status: \"revoked\"");
    expect(actions).toContain("platformAuditLogs");
    expect(actions).toContain("organization_plan_changed");
    expect(actions).toContain("organization_status_changed");
    expect(actions).not.toMatch(/purchases|stockMovements|sales|ingredients|recipes/);
  });

  it("preserves owner-token single-use and email-binding logic", () => {
    const owner = read("src/lib/owner-onboarding.ts");
    const action = read("src/server/actions/platform-admin.ts");
    expect(owner).toContain("OWNER_ONBOARDING_TTL_DAYS");
    expect(owner).toContain("status === \"claimed\"");
    expect(owner).toContain("email_mismatch");
    expect(action).toContain("ownerOnboardingTokens");
    expect(action).toContain("tokenHash");
  });

  it("enforces suspension and cancellation at the tenant guard", () => {
    const tenant = read("src/server/tenant.ts");
    expect(tenant).toContain("tenant.status === \"suspended\"");
    expect(tenant).toContain("tenant.status === \"cancelled\"");
    expect(tenant).toContain("/workspace-unavailable");
  });

  it("keeps platform tables server-only in RLS", () => {
    const rls = read("supabase/rls.sql");
    expect(rls).toMatch(/revoke all on table public\.owner_onboarding_tokens, public\.user_profiles, public\.platform_admins, public\.platform_audit_logs from anon, authenticated/);
    for (const table of ["user_profiles", "platform_admins", "platform_audit_logs"]) {
      expect(rls).toMatch(new RegExp(`alter table public\\.${table}\\s+enable row level security`));
    }
    expect(read("drizzle/0013_platform_admin.sql")).toContain("CREATE TRIGGER sync_user_profile");
  });

  it("does not expose operational-data editing controls in the admin routes", () => {
    const adminSources = [
      "src/app/admin/page.tsx",
      "src/app/admin/organizations/page.tsx",
      "src/app/admin/organizations/[id]/page.tsx",
      "src/app/admin/invitations/page.tsx",
      "src/app/admin/users/page.tsx",
      "src/app/admin/audit/page.tsx",
      "src/components/admin/organization-controls.tsx",
      "src/components/admin/owner-invitation-manager.tsx",
    ].map(read).join("\n");
    expect(adminSources).not.toMatch(/receivePurchase|recordSale|saveIngredient|saveRecipe|saveMenuItem|recordWaste|createStockCount/);
  });
});
