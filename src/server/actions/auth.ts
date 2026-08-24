"use server";

import { createClient } from "@/lib/supabase/server";
import { normalizeOnboardingEmail } from "@/lib/owner-onboarding";
import { safeNextPath } from "@/lib/redirects";
import { hashInvitationToken } from "@/lib/invitations";
import { checkOwnerOnboardingToken } from "@/server/queries/owner-onboarding";
import { findInvitationByTokenHash } from "@/server/queries/team";
import { getTenantContext } from "@/server/tenant";
import { getPlatformAdmin } from "@/server/platform-admin";
import { actionError, actionOk, toActionError, type ActionResult } from "@/server/action-result";

/**
 * Resolves the first destination after password authentication.
 *
 * Platform-admin authorization is checked before tenant membership so an admin
 * without a restaurant workspace never falls into the onboarding/no-access UI.
 * A safe invitation destination remains supported for normal restaurant users.
 */
export async function resolvePostAuthRoute(requestedNext?: string | null): Promise<string> {
  const platformAdmin = await getPlatformAdmin();
  if (platformAdmin) return "/admin";

  const next = safeNextPath(requestedNext);
  if (next && !next.startsWith("/admin")) return next;

  const tenant = await getTenantContext();
  if (!tenant) return "/auth/login";
  if ("needsOnboarding" in tenant) return "/onboarding";
  if (tenant.status === "suspended" || tenant.status === "cancelled") return "/workspace-unavailable";
  return "/dashboard";
}

export async function registerWithAuthorization(
  input: { email: string; password: string; token: string; kind: "employee" | "owner" },
): Promise<ActionResult<{ next: string }>> {
  try {
    const email = normalizeOnboardingEmail(input.email);
    const token = input.token.trim();
    if (!email || !token || input.password.length < 8) {
      return actionError("Enter a valid email, password and authorization link.");
    }

    if (input.kind === "employee") {
      const invitation = await findInvitationByTokenHash(hashInvitationToken(token));
      if (!invitation || invitation.email !== email || invitation.status !== "pending" || invitation.expiresAt.getTime() <= Date.now()) {
        return actionError("This employee invitation is not valid for that email address.");
      }
    } else {
      const { rejection } = await checkOwnerOnboardingToken(token, email);
      if (rejection) return actionError("This owner onboarding link is not valid for that email address.");
    }

    const supabase = await createClient();
    const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const next = input.kind === "employee" ? `/invite/${encodeURIComponent(token)}` : `/onboarding/${encodeURIComponent(token)}`;
    const callback = `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const result = await supabase.auth.signUp({ email, password: input.password, options: { emailRedirectTo: callback } });
    if (result.error) return actionError(result.error.message);

    if (result.data.user && result.data.user.email_confirmed_at) {
      return actionOk({ next });
    }
    return actionOk({ next });
  } catch (error) {
    return toActionError(error);
  }
}

export async function requestPasswordReset(email: string): Promise<ActionResult> {
  try {
    const supabase = await createClient();
    const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
    const result = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: `${origin}/auth/callback?next=/auth/reset-password`,
    });
    if (result.error) return actionError(result.error.message);
    return actionOk();
  } catch (error) {
    return toActionError(error);
  }
}
