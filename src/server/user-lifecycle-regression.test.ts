import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkOwnerOnboardingRedeemable } from "@/lib/owner-onboarding";

const read = (path: string) => readFileSync(path, "utf8");

describe("Auth user and Yield profile lifecycle", () => {
  const migration = read("drizzle/0014_auth_user_lifecycle.sql");
  const schema = read("src/db/schema.ts");
  const queries = read("src/server/queries/platform-admin.ts");
  const actions = read("src/server/actions/platform-admin.ts");
  const tenant = read("src/server/tenant.ts");
  const guard = read("src/server/platform-admin.ts");

  it("cleans orphan profiles and cascades future Auth deletions", () => {
    expect(migration).toContain("DELETE FROM public.user_profiles profile");
    expect(migration).toContain("FROM auth.users auth_user");
    expect(migration).toContain("FOREIGN KEY (user_id)");
    expect(migration).toContain("REFERENCES auth.users(id)");
    expect(migration).toContain("ON DELETE CASCADE");
    expect(migration).toMatch(/IF TG_OP = .DELETE./);
    expect(migration).toContain("DELETE FROM public.user_profiles WHERE user_id = OLD.id");
  });

  it("keeps Auth UUID as the identity key, not email", () => {
    expect(schema).toContain("userId: uuid(\"user_id\").primaryKey()");
    expect(schema).toContain("index(\"user_profiles_email_idx\")");
    expect(schema).not.toContain("uniqueIndex(\"user_profiles_email");
    expect(migration).toContain("ON CONFLICT (user_id) DO UPDATE");
  });

  it("builds /admin users from Supabase Admin API identities rather than stale profiles", () => {
    const listStart = queries.indexOf("export async function listPlatformUsers");
    const detailStart = queries.indexOf("export async function getPlatformUser");
    const list = queries.slice(listStart, detailStart);
    expect(queries).toContain("listAdminAuthUsers");
    expect(queries).toContain("getAdminAuthUserById");
    expect(list).toContain("listAdminAuthUsers()");
    expect(list).toContain("db.select({ userId: userProfiles.userId");
    expect(queries).not.toMatch(/authUsers|auth\.users|@\/db\/auth-schema/);
    expect(actions).not.toMatch(/authUsers|auth\.users|@\/db\/auth-schema/);
  });

  it("keeps /admin overview counts off the private auth schema", () => {
    const overviewStart = queries.indexOf("export async function getPlatformOverview");
    const invitationsStart = queries.indexOf("export async function listPlatformOwnerInvitations");
    const overview = queries.slice(overviewStart, invitationsStart);
    expect(overview).toContain("listAdminAuthUsers()");
    expect(overview).toContain("users: liveUsers.length");
    expect(overview).not.toMatch(/authUsers|auth\.users|@\/db\/auth-schema/);
  });

  it("deactivated profiles are denied restaurant and platform-admin access", () => {
    expect(tenant).toContain("profileStatus");
    expect(tenant).toContain("profile.status !== \"active\"");
    expect(guard).toContain("userProfiles.status");
    expect(guard).toContain("eq(userProfiles.status, \"active\")");
  });

  it("platform-admin user mutations require platform authorization, owner safety and audit rows", () => {
    for (const name of ["deactivatePlatformUser", "reactivatePlatformUser", "deletePlatformUser"]) {
      const start = actions.indexOf(`export async function ${name}`);
      const end = actions.indexOf("\nexport async function", start + 1);
      const body = actions.slice(start, end === -1 ? actions.length : end);
      expect(body).toContain("requirePlatformAdminAction");
      expect(body).toContain("platformAuditLogs");
    }
    expect(actions).toContain("admin.userId === userId");
    expect(actions).toContain("assertNotLastOrganizationOwner");
    expect(read("src/lib/supabase/admin.ts")).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(actions).toContain("auth.admin.deleteUser(userId)");
    expect(actions).toContain("user_deactivated");
    expect(actions).toContain("user_reactivated");
    expect(actions).toContain("user_deleted");
  });

  it("keeps the service-role key server-only", () => {
    const adminClient = read("src/lib/supabase/admin.ts");
    const clientSources = [read("src/components/admin/user-controls.tsx"), read("src/app/admin/users/page.tsx")].join("\n");
    expect(adminClient).toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(adminClient).not.toContain("NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY");
    expect(clientSources).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});

describe("first-owner onboarding after email verification", () => {
  const auth = read("src/server/actions/auth.ts");
  const callback = read("src/app/auth/callback/route.ts");
  const ownerPage = read("src/app/onboarding/[token]/page.tsx");
  const signout = read("src/app/auth/signout/route.ts");
  const signupPage = read("src/app/auth/sign-up/page.tsx");
  const organization = read("src/server/actions/organization.ts");

  it("preserves next=/onboarding/[token] through signup and callback", () => {
    expect(auth).toContain("/auth/callback?next=");
    expect(auth).toContain("`/onboarding/${encodeURIComponent(token)}`");
    expect(auth).toContain("next?.startsWith(\"/onboarding/\")");
    expect(callback).toContain("exchangeCodeForSession");
    expect(callback).toContain("safeNextPathOr");
    expect(callback).toContain("resolvePostAuthRoute(requestedNext)");
  });

  it("supports valid owner token branches for logged-out, same-email, and different-email sessions", () => {
    expect(ownerPage).toContain("if (!user)");
    expect(ownerPage).toContain("<AuthForm mode=\"signup\" token={token} authorizationKind=\"owner\" initialEmail={onboarding!.email}");
    expect(signupPage).toContain("initialEmail = onboarding?.email");
    expect(signupPage).toContain("<AuthForm mode=\"signup\" token={token} authorizationKind={kind} initialEmail={initialEmail}");

    expect(ownerPage).toContain("const tokenRejection = checkOwnerOnboardingRedeemable(onboarding, onboarding?.email ?? null)");
    expect(ownerPage).toContain("signedInEmail !== invitedEmail");
    expect(ownerPage).toContain("This invitation is for {invitedEmail}");
    expect(ownerPage).toContain("Sign out and continue");
    expect(ownerPage).toContain("/auth/signout?next=");

    expect(ownerPage.indexOf("signedInEmail !== invitedEmail")).toBeLessThan(ownerPage.indexOf("const tenant = await getTenantContext()"));
    expect(ownerPage).toContain("if (tenant && \"needsOnboarding\" in tenant) return <WorkspaceCreation ownerToken={token} />");
  });

  it("preserves the owner token through sign-out and verification callback", () => {
    expect(ownerPage).toContain("const next = `/onboarding/${encodeURIComponent(token)}`");
    expect(ownerPage).toContain("action={`/auth/signout?next=${encodeURIComponent(next)}`}");
    expect(signout).toContain("safeNextPathOr(searchParams.get(\"next\"), \"/auth/login\")");
    expect(auth).toContain("/auth/callback?next=");
    expect(auth).toContain("`/onboarding/${encodeURIComponent(token)}`");
    expect(callback).toContain("resolvePostAuthRoute(requestedNext)");
  });

  it("still rejects attempts to claim an owner token with a different email", () => {
    expect(auth).toContain("checkOwnerOnboardingToken(token, email)");
    expect(auth).toContain("This owner onboarding link is not valid for that email address.");
    expect(organization).toContain("checkOwnerOnboardingRedeemable(ownerAuthorization, user.email ?? null)");
    expect(checkOwnerOnboardingRedeemable({ email: "owner@example.com", status: "pending", expiresAt: new Date(Date.now() + 60_000) }, "other@example.com")).toBe("email_mismatch");
  });

  it("requires verified owner email before workspace creation", () => {
    expect(ownerPage).toContain("!user.email_confirmed_at");
    expect(organization).toContain("!user.email_confirmed_at");
    expect(organization).toContain("Verify your email address before creating this workspace.");
  });

  it("claims the owner token in the same transaction as workspace creation", () => {
    const start = organization.indexOf("export async function createWorkspace");
    const body = organization.slice(start, organization.indexOf("export async function completeSetup", start));
    expect(body).toContain("checkOwnerOnboardingRedeemable");
    expect(body).toContain("db.transaction");
    expect(body).toContain("status: \"claimed\"");
    expect(body).toContain("eq(ownerOnboardingTokens.status, \"pending\")");
    expect(body.indexOf(".update(ownerOnboardingTokens)")).toBeLessThan(body.indexOf(".insert(organizations)"));
    expect(body).toContain("role: \"owner\"");
  });

  it("continues blocking invalid owner onboarding tokens", () => {
    const base = { email: "owner@example.com", expiresAt: new Date(Date.now() + 60_000) };
    expect(checkOwnerOnboardingRedeemable(null, "owner@example.com")).toBe("not_found");
    expect(checkOwnerOnboardingRedeemable({ ...base, status: "revoked" }, "owner@example.com")).toBe("revoked");
    expect(checkOwnerOnboardingRedeemable({ ...base, status: "claimed" }, "owner@example.com")).toBe("claimed");
    expect(checkOwnerOnboardingRedeemable({ ...base, status: "pending", expiresAt: new Date(Date.now() - 1) }, "owner@example.com")).toBe("expired");
    expect(checkOwnerOnboardingRedeemable({ ...base, status: "pending" }, "other@example.com")).toBe("email_mismatch");
    expect(checkOwnerOnboardingRedeemable({ ...base, status: "pending" }, "owner@example.com")).toBeNull();
  });
});
