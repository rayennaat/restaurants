import Link from "next/link";
import { Activity, Building2, KeyRound, MapPin, Users } from "lucide-react";
import { getPlatformOverview, PLAN_LABELS, STATUS_LABELS } from "@/server/queries/platform-admin";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

export default async function AdminOverviewPage() {
  const overview = await getPlatformOverview();
  return (
    <>
      <PageHeader eyebrow="Platform" title="Overview" description="Monitor Yield organizations, onboarding and platform activity." />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Organizations" value={overview.organizations} icon={Building2} />
        <Metric label="Active pilots" value={overview.activePilots} icon={Activity} />
        <Metric label="Users" value={overview.users} icon={Users} />
        <Metric label="Locations" value={overview.locations} icon={MapPin} />
        <Metric label="Pending owner links" value={overview.pendingOwnerInvitations} icon={KeyRound} />
      </div>
      <div className="mt-6 grid gap-5 xl:grid-cols-[1.35fr_1fr]">
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <h2 className="font-black">Recent organizations</h2>
            <p className="text-sm text-[var(--muted)]">Newest workspaces and their current platform state.</p>
          </CardHeader>
          <Table>
            <THead><TR><TH>Organization</TH><TH>Plan</TH><TH>Status</TH><TH>Created</TH></TR></THead>
            <TBody>
              {overview.recentOrganizations.map(org => (
                <TR key={org.id}>
                  <TD><Link href={`/admin/organizations/${org.id}`} className="font-bold text-green-900 hover:underline">{org.name}</Link></TD>
                  <TD>{PLAN_LABELS[org.plan]}</TD>
                  <TD><Badge tone={org.status === "suspended" || org.status === "cancelled" ? "danger" : org.status === "pilot" ? "warning" : "success"}>{STATUS_LABELS[org.status]}</Badge></TD>
                  <TD>{formatDate(org.createdAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <h2 className="font-black">Recent platform activity</h2>
            <p className="text-sm text-[var(--muted)]">Administrative actions only.</p>
          </CardHeader>
          <div className="divide-y">
            {overview.recentAudit.length === 0 ? (
              <p className="p-5 text-sm text-[var(--muted)]">No platform activity yet.</p>
            ) : overview.recentAudit.map(entry => (
              <div key={entry.id} className="p-4">
                <p className="text-sm font-semibold">{entry.action.replaceAll("_", " ")}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">{formatDate(entry.createdAt)}{entry.organizationId ? ` · ${entry.organizationId}` : ""}</p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

function Metric({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Building2 }) {
  return <Card><CardContent className="flex items-center justify-between gap-3 pt-4"><div><p className="text-xs font-bold uppercase tracking-wide text-[var(--muted)]">{label}</p><p className="mt-1 text-2xl font-black tabular-nums">{value}</p></div><Icon size={20} className="text-green-800" aria-hidden="true" /></CardContent></Card>;
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(value);
}
