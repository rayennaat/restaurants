import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { AuthForm } from "@/components/auth/auth-form";
import { checkOwnerOnboardingRedeemable, hashOwnerOnboardingToken } from "@/lib/owner-onboarding";
import { checkInvitationRedeemable, hashInvitationToken } from "@/lib/invitations";
import { findOwnerOnboardingByTokenHash } from "@/server/queries/owner-onboarding";
import { findInvitationByTokenHash } from "@/server/queries/team";

type SearchParams = { token?: string | string[]; kind?: string | string[]; email?: string | string[] };
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

function BlockedRegistration() {
  return (
    <main className="grid min-h-screen place-items-center p-5 grid-bg">
      <Card className="w-full max-w-md">
        <CardContent className="pt-7 text-center">
          <h1 className="text-2xl font-black">Registration unavailable</h1>
          <p className="mt-2 text-[var(--muted)]">Registration is available by invitation only.</p>
        </CardContent>
      </Card>
    </main>
  );
}

export default async function SignUpPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const token = first(params.token)?.trim();
  const kind = first(params.kind);
  const email = first(params.email)?.trim().toLowerCase();

  if (!token || (kind !== "employee" && kind !== "owner")) return <BlockedRegistration />;

  let initialEmail: string | undefined;
  if (kind === "employee") {
    const invitation = await findInvitationByTokenHash(hashInvitationToken(token));
    const rejection = checkInvitationRedeemable(invitation, email ?? null);
    if (rejection || !invitation) return <BlockedRegistration />;
    initialEmail = invitation.email;
  } else {
    const onboarding = await findOwnerOnboardingByTokenHash(hashOwnerOnboardingToken(token));
    const rejection = checkOwnerOnboardingRedeemable(onboarding, email ?? null);
    if (rejection && rejection !== "email_mismatch") return <BlockedRegistration />;
    initialEmail = onboarding?.email;
    if (!onboarding || !initialEmail) return <BlockedRegistration />;
  }

  return (
    <main className="grid min-h-screen place-items-center p-5 grid-bg">
      <div className="w-full max-w-md rounded-lg border bg-white p-7 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-black uppercase tracking-[.2em] text-green-700">
          <span className="grid size-8 place-items-center overflow-hidden rounded-lg bg-white ring-1 ring-green-900/10">
            <Image src="/logos/logo2.png" alt="" width={1254} height={1254} className="size-full object-cover" />
          </span>
          Yield
        </div>
        <h1 className="mt-3 text-3xl font-black">{kind === "owner" ? "Set up your restaurant" : "Join your restaurant"}</h1>
        <p className="mb-7 mt-2 text-[var(--muted)]">Create the account authorized by this secure link.</p>
        <AuthForm mode="signup" token={token} authorizationKind={kind} initialEmail={initialEmail} />
      </div>
    </main>
  );
}
