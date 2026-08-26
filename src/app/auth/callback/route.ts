import { createClient } from "@/lib/supabase/server";
import { safeNextPathOr } from "@/lib/redirects";
import { resolvePostAuthRoute } from "@/server/actions/auth";
import { NextResponse } from "next/server";

/**
 * Supabase auth callback.
 *
 * Honours a `next` destination so an invited employee returns to the invitation
 * they came from instead of being sent to workspace creation — which would have
 * them build a second, empty organization rather than joining the one that
 * invited them.
 *
 * `next` is attacker-controllable, so it is validated by `safeNextPathOr`, which
 * accepts a same-origin path and nothing else — see `lib/redirects` for the two
 * shapes (`/\host`, and a tab that collapses into `//host`) that the obvious
 * "starts with a slash" check lets through. Anything rejected falls back to
 * onboarding rather than becoming an open redirect.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    await supabase.auth.exchangeCodeForSession(code);
  }
  const requestedNext = safeNextPathOr(searchParams.get("next"), "/onboarding");
  // Owner onboarding tokens are authorization-bearing destinations. Preserve
  // the exact token path before membership/no-workspace fallback can collapse a
  // verified first owner to generic onboarding.
  const destination = requestedNext.startsWith("/onboarding/")
    ? requestedNext
    : requestedNext === "/reset-password"
      ? requestedNext
      : await resolvePostAuthRoute(requestedNext);
  return NextResponse.redirect(`${origin}${destination}`);
}
