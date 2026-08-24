import Link from "next/link";
import { ArrowLeft, Building2, MapPin, Users } from "lucide-react";
import { getPlatformOrganization } from "@/server/queries/platform-admin";
import { OrganizationControls } from "@/components/admin/organization-controls";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

export default async function AdminOrganizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getPlatformOrganization(id);
  if (!detail) return <Card><CardContent className="py-10 text-center"><h1 className="text-xl font-black">Organization not found</h1><Link href="/admin/organizations" className="mt-3 inline-block font-semibold text-green-900 hover:underline">Back to organizations</Link></CardContent></Card>;
  const { organization } = detail;
  return <>
    <Link href="/admin/organizations" className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-green-900 hover:underline"><ArrowLeft size={15} aria-hidden="true" /> Organizations</Link>
    <PageHeader eyebrow="Organization" title={organization.name} description={`Created ${formatDate(organization.createdAt)} · ${organization.slug}`} />
    <div className="grid gap-3 sm:grid-cols-3"><Metric label="Users" value={detail.members.length} icon={Users} /><Metric label="Locations" value={detail.locations.length} icon={MapPin} /><Metric label="Ingredients" value={detail.counts.ingredients} icon={Building2} /></div>
    <div className="mt-6 grid gap-5 xl:grid-cols-[1fr_.9fr]">
      <Card><CardHeader className="border-b"><h2 className="font-black">Platform access</h2><p className="text-sm text-[var(--muted)]">Plan and access status affect the restaurant workspace only.</p></CardHeader><CardContent className="pt-5"><OrganizationControls organizationId={organization.id} initialPlan={organization.plan} initialStatus={organization.status} /></CardContent></Card>
      <Card><CardHeader className="border-b"><h2 className="font-black">Usage snapshot</h2></CardHeader><CardContent className="grid grid-cols-3 gap-3 pt-5"><Usage label="Ingredients" value={detail.counts.ingredients} /><Usage label="Purchases" value={detail.counts.purchases} /><Usage label="Sales" value={detail.counts.sales} /></CardContent></Card>
    </div>
    <div className="mt-5 grid gap-5 xl:grid-cols-2">
      <Card className="overflow-hidden"><CardHeader className="border-b"><h2 className="font-black">Users</h2></CardHeader><Table><THead><TR><TH>Email</TH><TH>Role</TH><TH>Joined</TH></TR></THead><TBody>{detail.members.map(member => <TR key={member.userId}><TD>{member.email || "Unavailable"}</TD><TD><Badge>{member.role}</Badge></TD><TD>{formatDate(member.joinedAt)}</TD></TR>)}</TBody></Table></Card>
      <Card className="overflow-hidden"><CardHeader className="border-b"><h2 className="font-black">Locations</h2></CardHeader><Table><THead><TR><TH>Name</TH><TH>Status</TH><TH>Created</TH></TR></THead><TBody>{detail.locations.map(location => <TR key={location.id}><TD>{location.name}</TD><TD><Badge tone={location.active ? "success" : "neutral"}>{location.active ? "Active" : "Archived"}</Badge></TD><TD>{formatDate(location.createdAt)}</TD></TR>)}</TBody></Table></Card>
    </div>
  </>;
}

function Metric({ label, value, icon: Icon }: { label: string; value: number; icon: typeof Users }) { return <Card><CardContent className="flex items-center justify-between pt-4"><div><p className="text-xs font-bold uppercase text-[var(--muted)]">{label}</p><p className="mt-1 text-2xl font-black">{value}</p></div><Icon size={19} className="text-green-800" aria-hidden="true" /></CardContent></Card>; }
function Usage({ label, value }: { label: string; value: number }) { return <div><p className="text-xs text-[var(--muted)]">{label}</p><p className="mt-1 text-xl font-black tabular-nums">{value}</p></div>; }
function formatDate(value: Date) { return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(value); }
