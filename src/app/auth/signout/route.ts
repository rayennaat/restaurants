import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

/**
 * Signs the user out and returns them to the login screen.
 *
 * Unconditional. This handler used to skip the sign-out entirely when demo mode
 * was on, which is the one shortcut a preview flag must never take: if the flag
 * were ever set in a deployed environment, "Sign out" would clear nothing and
 * the next person at a shared terminal would inherit the session. Demo mode now
 * cannot be on in a production build either — see `lib/demo-mode` — so this is
 * belt and braces, and the failure it guards against is severe enough to want
 * both.
 *
 * The call is wrapped because a preview environment points at a placeholder
 * Supabase URL, where the network request fails. A failed revocation must still
 * end in a redirect to the login page rather than a 500 that leaves the user
 * looking at an error with their session apparently intact.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    await supabase.auth.signOut();
  } catch (error) {
    console.error("sign-out failed", error);
  }
  return NextResponse.redirect(new URL("/auth/login", request.url), 303);
}
