import { redirect } from "next/navigation";
import { getTenantContext } from "@/server/tenant";
import { WorkspaceCreation } from "@/components/onboarding/workspace-creation";
import { SetupChecklist } from "@/components/onboarding/setup-checklist";
import { getSetupProgress } from "@/server/queries/onboarding";
import { listPendingInvitationsForEmail } from "@/server/queries/team";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Get Started" };

/**
 * Onboarding branches on tenant state:
 *  - No org yet → workspace creation form
 *  - Org exists but setup incomplete → 4-step guided checklist
 *  - Setup complete → redirect to dashboard
 */
export default async function OnboardingPage() {
  const state = await getTenantContext();

  if (!state || "needsOnboarding" in state) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // Someone invited this address but they landed here instead of following
    // the link. Creating a workspace now would strand them: `getTenantContext`
    // picks the oldest membership, so they would keep landing in their own
    // empty organization even after accepting. We cannot rebuild their link —
    // only the token hash is stored — so we tell them to use the one they were
    // sent, and leave the choice with them.
    const invitations = user?.email ? await listPendingInvitationsForEmail(user.email) : [];

    return <WorkspaceCreation pendingInvitations={invitations.map(invitation => invitation.organizationName)} />;
  }

  // Organization exists. If setup is finished, go straight to the dashboard.
  const setup = await getSetupProgress(state.organizationId);
  if (setup.allStepsComplete) redirect("/dashboard");

  // Setup incomplete — show the guided checklist.
  return <SetupChecklist progress={setup} />;
}
