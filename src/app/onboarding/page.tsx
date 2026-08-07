import { redirect } from "next/navigation";
import { getTenantContext } from "@/server/tenant";
import { WorkspaceCreation } from "@/components/onboarding/workspace-creation";
import { SetupChecklist } from "@/components/onboarding/setup-checklist";
import { getSetupProgress } from "@/server/queries/onboarding";

export const metadata = { title: "Get Started" };

/**
 * Onboarding branches on tenant state:
 *  - No org yet → workspace creation form
 *  - Org exists but setup incomplete → 4-step guided checklist
 *  - Setup complete → redirect to dashboard
 */
export default async function OnboardingPage() {
  const state = await getTenantContext();

  // No organization yet — show the workspace creation form.
  if (!state || "needsOnboarding" in state) {
    return <WorkspaceCreation />;
  }

  // Organization exists. If setup is finished, go straight to the dashboard.
  const setup = await getSetupProgress(state.organizationId);
  if (setup.allStepsComplete) redirect("/dashboard");

  // Setup incomplete — show the guided checklist.
  return <SetupChecklist progress={setup} />;
}
