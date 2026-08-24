import Link from "next/link";
import { redirect } from "next/navigation";
import { MailCheck, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AcceptInvitation } from "@/components/team/accept-invitation";
import { checkInvitationRedeemable, hashInvitationToken, INVITATION_REJECTION_MESSAGES } from "@/lib/invitations";
import { createClient } from "@/lib/supabase/server";
import { findInvitationByTokenHash } from "@/server/queries/team";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/server/tenant";

export const metadata = { title: "Join workspace" };

/**
 * Invitation acceptance.
 *
 * The token in the URL is the only thing that identifies the invitation, and it
 * is looked up by hash — the raw value is never stored. Redeemability is
 * decided by `checkInvitationRedeemable`, including the requirement that the
 * signed-in address match the invited one, so forwarding the link to someone
 * else achieves nothing.
 *
 * A signed-out visitor is sent to sign-in with `next` pointing back here, so
 * they return to this page once Supabase has verified who they are.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const invitation = await findInvitationByTokenHash(hashInvitationToken(token));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // A new employee must use the server-validated registration form. Existing
  // accounts still use the normal login route and return here afterward.
  if (!user) {
    const next = encodeURIComponent(`/invite/${token}`);
    redirect(`/auth/sign-up?kind=employee&token=${encodeURIComponent(token)}&email=${encodeURIComponent(invitation?.email ?? "")}&next=${next}`);
  }

  // Do not treat a self-asserted address as proof of mailbox ownership. This
  // remains required even if a Supabase project later allows unconfirmed sign-in.
  const verifiedEmail = user.email_confirmed_at ? (user.email ?? null) : null;
  const rejection = checkInvitationRedeemable(invitation, verifiedEmail);

  if (rejection || !invitation) {
    return (
      <main className="grid min-h-screen place-items-center p-5">
        <Card className="max-w-md">
          <CardContent className="pt-6 text-center">
            <span className="mx-auto grid size-12 place-items-center rounded-lg bg-red-50 text-red-700">
              <ShieldAlert size={24} />
            </span>
            <h1 className="mt-4 text-2xl font-black">Invitation unavailable</h1>
            <p className="mt-2 text-[var(--muted)]">
              {INVITATION_REJECTION_MESSAGES[rejection ?? "not_found"]}
            </p>
            {rejection === "email_mismatch" && (
              <p className="mt-2 text-sm text-[var(--muted)]">
                You are signed in as <b>{user.email}</b>.
              </p>
            )}
            <Link href="/dashboard" className="mt-6 block">
              <Button variant="secondary" className="w-full">
                Go to dashboard
              </Button>
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="grid min-h-screen place-items-center p-5">
      <Card className="max-w-md">
        <CardContent className="pt-6 text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-lg bg-green-50 text-green-800">
            <MailCheck size={24} />
          </span>
          <h1 className="mt-4 text-2xl font-black">Join {invitation.organizationName}</h1>
          <p className="mt-2 text-[var(--muted)]">
            You have been invited as <b>{ROLE_LABELS[invitation.role]}</b>.
          </p>
          <p className="mt-3 rounded-lg bg-neutral-50 p-3 text-sm text-[var(--muted)]">
            {ROLE_DESCRIPTIONS[invitation.role]}
          </p>
          <p className="mt-3 text-xs text-[var(--muted)]">Accepting as {user.email}</p>

          <AcceptInvitation token={token} organizationName={invitation.organizationName} />
        </CardContent>
      </Card>
    </main>
  );
}
