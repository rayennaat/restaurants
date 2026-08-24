import Link from "next/link";
import { ArrowRight, Building2, ShieldCheck, Users } from "lucide-react";
import { PageHeader } from "@/components/dashboard/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { listTeamMembers } from "@/server/queries/team";
import { hasPermission, requireTenant, MEMBER_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/server/tenant";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const tenant = await requireTenant();
  const members = await listTeamMembers(tenant.organizationId, tenant.userId);

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Settings"
        description="Country-specific currency, language, timezone and measurement settings belong to each organization."
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]"><Users size={13} /> Team</p>
          <p className="mt-1 text-2xl font-black tabular-nums">{members.length}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]"><ShieldCheck size={13} /> Your role</p>
          <p className="mt-1 text-sm font-bold">{ROLE_LABELS[tenant.role]}</p>
        </div>
        <div className="rounded-lg border bg-white px-4 py-3 shadow-sm">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-[var(--muted)]"><Building2 size={13} /> Configuration</p>
          <p className="mt-1 text-sm font-bold">Workspace defaults set</p>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.15fr_.85fr]">
        <Link href="/dashboard/settings/team" className="block">
          <Card className="h-full transition hover:border-green-700">
            <CardHeader className="flex items-start justify-between gap-3 border-b">
              <div>
                <h2 className="flex items-center gap-2 text-lg font-black">
                  <Users size={18} /> Team
                </h2>
                <p className="text-sm text-[var(--muted)]">
                  {members.length} {members.length === 1 ? "person has" : "people have"} access to this workspace
                </p>
              </div>
              <ArrowRight size={18} className="mt-1 shrink-0 text-[var(--muted)]" />
            </CardHeader>
            <CardContent className="space-y-2">
              {members.slice(0, 4).map(member => (
                <div key={member.userId} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">{member.displayName}</span>
                  <Badge tone={member.role === "owner" ? "danger" : "neutral"}>{ROLE_LABELS[member.role]}</Badge>
                </div>
              ))}
              {members.length > 4 && <p className="text-xs text-[var(--muted)]">and {members.length - 4} more…</p>}
              {hasPermission(tenant.role, "manage_team") && (
                <p className="pt-1 text-xs text-[var(--muted)]">You can invite employees and change roles.</p>
              )}
            </CardContent>
          </Card>
        </Link>

        <Card>
          <CardHeader className="border-b">
            <h2 className="text-lg font-black">Roles</h2>
            <p className="text-sm text-[var(--muted)]">What each role is allowed to do. Enforced on the server.</p>
          </CardHeader>
          <CardContent className="grid gap-2">
            {MEMBER_ROLES.map(role => (
              <div key={role} className="rounded-lg border bg-neutral-50/60 p-3">
                <Badge tone={role === "owner" ? "danger" : role === "manager" ? "success" : "neutral"}>{ROLE_LABELS[role]}</Badge>
                <p className="mt-1.5 text-sm text-[var(--muted)]">{ROLE_DESCRIPTIONS[role]}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-5 max-w-none">
        <CardHeader className="border-b">
          <h2 className="text-lg font-black">Configured foundation</h2>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-[var(--muted)] sm:grid-cols-2">
          <p>✓ Multi-tenant organization and location model</p>
          <p>✓ Role model for owners, managers, inventory, kitchen and accounting</p>
          <p>✓ Tunisia-ready TND/fr-TN/Africa-Tunis defaults</p>
          <p>✓ New York-ready USD/en-US/America-New_York structure</p>
        </CardContent>
      </Card>
    </>
  );
}
