import { OwnerInvitationManager } from "@/components/admin/owner-invitation-manager";
import { PageHeader } from "@/components/dashboard/page-header";
import { listPlatformOwnerInvitations } from "@/server/queries/platform-admin";

export default async function AdminInvitationsPage() {
  const invitations = await listPlatformOwnerInvitations();
  return <><PageHeader eyebrow="Platform" title="Owner invitations" description="Create and revoke first-owner onboarding links for new restaurant workspaces." /><OwnerInvitationManager invitations={invitations} /></>;
}
