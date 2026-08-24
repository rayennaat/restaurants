import { redirect } from "next/navigation";
import { getTenantContext } from "@/server/tenant";
import { getPlatformAdmin } from "@/server/platform-admin";
import { SetupChecklist } from "@/components/onboarding/setup-checklist";
import { getSetupProgress } from "@/server/queries/onboarding";

export const metadata = { title: "Get Started" };

export default async function OnboardingPage() {
  const platformAdmin = await getPlatformAdmin();
  if (platformAdmin) redirect("/admin");

  const state = await getTenantContext();

  if (!state) redirect("/auth/login");
  if ("needsOnboarding" in state) {
    return (
      <main className="grid min-h-screen place-items-center p-5">
        <div className="w-full max-w-lg rounded-lg border bg-white p-7 text-center shadow-sm">
          <h1 className="text-2xl font-black">No Yield workspace access</h1>
          <p className="mt-2 text-[var(--muted)]">
            You don’t currently have access to a Yield workspace. Ask your restaurant administrator for an invitation or request access.
          </p>
        </div>
      </main>
    );
  }

  const setup = await getSetupProgress(state.organizationId);
  if (setup.allStepsComplete) redirect("/dashboard");
  return <SetupChecklist progress={setup} />;
}
