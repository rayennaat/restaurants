import Link from "next/link";
import { ArrowLeft, Mail, MapPin, Users } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { TeamManager } from "@/components/team/team-manager";
import { listLocationOptions } from "@/server/queries/locations";
import { listPendingInvitations, listTeamMembers } from "@/server/queries/team";
import { hasPermission, requireTenant } from "@/server/tenant";

export const metadata = { title: "Team" };

/**
 * Team management.
 *
 * Reading the roster is open to any member — knowing who your colleagues are is
 * not privileged. Mutating it requires `manage_team`, which is enforced in the
 * server actions; `canManageTeam` here only decides whether the controls are
 * worth rendering.
 */
export default async function TeamPage() {
  const tenant = await requireTenant();

  const [members, invitations, locations] = await Promise.all([
    listTeamMembers(tenant.organizationId, tenant.userId),
    hasPermission(tenant.role, "manage_team") ? listPendingInvitations(tenant.organizationId) : Promise.resolve([]),
    listLocationOptions(tenant.organizationId),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Team"
        description="Who can access this workspace and what each person is allowed to do. Roles are enforced on the server, not just in the interface."
      />

      <Link href="/dashboard/settings" className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-[var(--muted)] hover:text-neutral-900">
        <ArrowLeft size={15} /> Back to settings
      </Link>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]"><Users size={13} /> Members</p>
          <p className="mt-1 text-2xl font-black tabular-nums">{members.length}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]"><Mail size={13} /> Pending invites</p>
          <p className="mt-1 text-2xl font-black tabular-nums text-amber-700">{invitations.length}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]"><MapPin size={13} /> Locations</p>
          <p className="mt-1 text-2xl font-black tabular-nums text-green-900">{locations.length}</p>
        </div>
      </div>

      <TeamManager
        members={members}
        invitations={invitations}
        locations={locations}
        canManageTeam={hasPermission(tenant.role, "manage_team")}
        canTransferOwnership={hasPermission(tenant.role, "transfer_ownership")}
      />
    </>
  );
}
