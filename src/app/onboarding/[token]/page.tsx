import Link from "next/link";
import { redirect } from "next/navigation";
import { KeyRound, ShieldAlert } from "lucide-react";
import { AuthForm } from "@/components/auth/auth-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { checkOwnerOnboardingRedeemable, hashOwnerOnboardingToken, OWNER_ONBOARDING_REJECTION_MESSAGES } from "@/lib/owner-onboarding";
import { createClient } from "@/lib/supabase/server";
import { findOwnerOnboardingByTokenHash } from "@/server/queries/owner-onboarding";
import { getTenantContext } from "@/server/tenant";
import { WorkspaceCreation } from "@/components/onboarding/workspace-creation";

export const metadata = { title: "Owner onboarding" };

export default async function OwnerOnboardingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const onboarding = await findOwnerOnboardingByTokenHash(hashOwnerOnboardingToken(token));
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const tokenRejection = checkOwnerOnboardingRedeemable(onboarding, onboarding?.email ?? null);
  const signedInEmail = user?.email?.trim().toLowerCase() ?? null;
  const invitedEmail = onboarding?.email.trim().toLowerCase() ?? null;

  if (!user && tokenRejection) {
    return (
      <main className="grid min-h-screen place-items-center p-5">
        <Card className="max-w-md">
          <CardContent className="pt-7 text-center">
            <ShieldAlert className="mx-auto text-red-700" size={28} />
            <h1 className="mt-4 text-2xl font-black">Owner onboarding unavailable</h1>
            <p className="mt-2 text-[var(--muted)]">{OWNER_ONBOARDING_REJECTION_MESSAGES[tokenRejection]}</p>
            <Link href="/auth/login" className="mt-6 block"><Button variant="secondary" className="w-full">Go to login</Button></Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="grid min-h-screen place-items-center p-5">
        <Card className="max-w-md">
          <CardContent className="pt-7">
            <div className="text-center">
              <KeyRound className="mx-auto text-green-800" size={28} />
              <h1 className="mt-4 text-2xl font-black">Set up your restaurant</h1>
              <p className="mt-2 text-[var(--muted)]">Create the account authorized by this secure link.</p>
            </div>
            <div className="mt-6">
              <AuthForm mode="signup" token={token} authorizationKind="owner" initialEmail={onboarding!.email} />
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (!tokenRejection && invitedEmail && signedInEmail !== invitedEmail) {
    const next = `/onboarding/${encodeURIComponent(token)}`;
    return (
      <main className="grid min-h-screen place-items-center p-5">
        <Card className="max-w-md">
          <CardContent className="pt-7 text-center">
            <ShieldAlert className="mx-auto text-amber-700" size={28} />
            <h1 className="mt-4 text-2xl font-black">Use the invited account</h1>
            <p className="mt-2 text-[var(--muted)]">This invitation is for {invitedEmail}. You&apos;re currently signed in with another account.</p>
            <form action={`/auth/signout?next=${encodeURIComponent(next)}`} method="post" className="mt-6">
              <Button className="w-full" type="submit">Sign out and continue</Button>
            </form>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (!user.email_confirmed_at) {
    return (
      <main className="grid min-h-screen place-items-center p-5">
        <Card className="max-w-md">
          <CardContent className="pt-7 text-center">
            <KeyRound className="mx-auto text-green-800" size={28} />
            <h1 className="mt-4 text-2xl font-black">Verify your email</h1>
            <p className="mt-2 text-[var(--muted)]">Confirm the authorized owner email, then return to this onboarding link.</p>
          </CardContent>
        </Card>
      </main>
    );
  }
  if (tokenRejection) {
    return (
      <main className="grid min-h-screen place-items-center p-5">
        <Card className="max-w-md">
          <CardContent className="pt-7 text-center">
            <ShieldAlert className="mx-auto text-red-700" size={28} />
            <h1 className="mt-4 text-2xl font-black">Owner onboarding unavailable</h1>
            <p className="mt-2 text-[var(--muted)]">{OWNER_ONBOARDING_REJECTION_MESSAGES[tokenRejection]}</p>
            <Link href="/auth/login" className="mt-6 block"><Button variant="secondary" className="w-full">Go to login</Button></Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  const tenant = await getTenantContext();
  if (tenant && !("needsOnboarding" in tenant)) redirect("/dashboard");
  if (tenant && "needsOnboarding" in tenant) return <WorkspaceCreation ownerToken={token} />;

  return (
    <main className="grid min-h-screen place-items-center p-5">
      <Card className="max-w-md">
        <CardContent className="pt-7 text-center">
          <h1 className="text-2xl font-black">Sign in to continue</h1>
          <p className="mt-2 text-[var(--muted)]">Use the authorized owner email for this onboarding link.</p>
          <AuthForm mode="login" />
        </CardContent>
      </Card>
    </main>
  );
}
