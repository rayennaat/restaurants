import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { safeNextPathOr } from "@/lib/redirects";
import { resolvePostAuthRoute } from "@/server/actions/auth";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const requestedNext = safeNextPathOr(searchParams.get("next"), "/onboarding");
  const requestedOwnerOnboarding = requestedNext.startsWith("/onboarding/");
  const cookieStore = await cookies();
  const cookiesToSet: Parameters<typeof cookieStore.set>[] = [];

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: values => {
        for (const { name, value, options } of values) {
          try {
            cookieStore.set(name, value, options);
          } catch {}
          cookiesToSet.push([name, value, options]);
        }
      },
    },
  });

  let exchangeSucceeded = false;
  let sessionExists = false;
  let userId: string | null = null;
  let email: string | null = null;

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    exchangeSucceeded = !error;
    sessionExists = Boolean(data.session);
    if (error) {
      console.error("auth callback verification exchange failed", {
        callbackReceivedCode: true,
        requestedOnboardingDestinationExists: requestedOwnerOnboarding,
        codeExchangeSuccess: false,
        sessionExists: false,
      });
      return verificationSessionError();
    }

    const { data: userData, error: userError } = await supabase.auth.getUser();
    userId = userData.user?.id ?? null;
    email = userData.user?.email ?? null;
    if (userError || !userData.user) {
      console.error("auth callback session missing after exchange", {
        callbackReceivedCode: true,
        requestedOnboardingDestinationExists: requestedOwnerOnboarding,
        codeExchangeSuccess: true,
        sessionExists,
        authenticatedUserUuid: userId,
        authenticatedEmail: email,
      });
      return verificationSessionError();
    }
  }

  console.info("auth callback completed", {
    callbackReceivedCode: Boolean(code),
    requestedOnboardingDestinationExists: requestedOwnerOnboarding,
    codeExchangeSuccess: code ? exchangeSucceeded : null,
    authenticatedUserUuid: userId,
    authenticatedEmail: email,
    sessionExists,
  });

  // Owner onboarding tokens are authorization-bearing destinations. Preserve
  // the exact token path before membership/no-workspace fallback can collapse a
  // verified first owner to generic onboarding.
  const destination = requestedOwnerOnboarding
    ? requestedNext
    : requestedNext === "/reset-password"
      ? requestedNext
      : await resolvePostAuthRoute(requestedNext);

  const response = NextResponse.redirect(origin + destination);
  for (const args of cookiesToSet) response.cookies.set(...args);
  return response;
}

function verificationSessionError() {
  return new NextResponse(
    "<!doctype html><html><body><main><h1>Email verification session could not be completed</h1><p>Open the latest verification email in the same browser where you created the account, or request a new owner invitation.</p></main></body></html>",
    { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}
