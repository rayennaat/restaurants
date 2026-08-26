import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getPlatformUser } from "@/server/queries/platform-admin";
import { UserControls } from "@/components/admin/user-controls";
import { PageHeader } from "@/components/dashboard/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getPlatformUser(id);
  if (!detail) {
    return <Card><CardContent className="py-10 text-center"><h1 className="text-xl font-black">User not found</h1><Link href="/admin/users" className="mt-3 inline-block font-semibold text-green-900 hover:underline">Back to users</Link></CardContent></Card>;
  }
  const { user, memberships } = detail;
  return (
    <>
      <Link href="/admin/users" className="mb-4 inline-flex items-center gap-2 text-sm font-semibold text-green-900 hover:underline"><ArrowLeft size={15} aria-hidden="true" /> Users</Link>
      <PageHeader eyebrow="Platform user" title={user.email ?? "Unavailable email"} description={user.userId} />
      <div className="grid gap-5 xl:grid-cols-[1fr_.8fr]">
        <Card><CardHeader className="border-b"><h2 className="font-black">Account</h2></CardHeader><CardContent className="grid gap-4 pt-5 sm:grid-cols-2"><Metric label="Verification" value={user.emailConfirmedAt ? "Verified" : "Unverified"} tone={user.emailConfirmedAt ? "success" : "warning"} /><Metric label="Access" value={user.status === "disabled" ? "Disabled" : "Active"} tone={user.status === "disabled" ? "danger" : "success"} /><Info label="Created" value={user.createdAt ? formatDate(user.createdAt) : "—"} /><Info label="Last sign-in" value={user.lastSeenAt ? formatDate(user.lastSeenAt) : "—"} /></CardContent></Card>
        <Card><CardHeader className="border-b"><h2 className="font-black">Access controls</h2><p className="text-sm text-[var(--muted)]">Platform-admin only. Last owners and self-removal are blocked server-side.</p></CardHeader><CardContent className="pt-5"><UserControls userId={user.userId} status={user.status} /></CardContent></Card>
      </div>
      <Card className="mt-5 overflow-hidden"><CardHeader className="border-b"><h2 className="font-black">Memberships</h2></CardHeader><Table><THead><TR><TH>Organization</TH><TH>Role</TH><TH>Joined</TH></TR></THead><TBody>{memberships.length === 0 ? <TR><TD colSpan={3} className="py-8 text-center text-[var(--muted)]">No current organization memberships.</TD></TR> : memberships.map(member => <TR key={member.organizationId}><TD><Link href={`/admin/organizations/${member.organizationId}`} className="font-semibold text-green-900 hover:underline">{member.organizationName}</Link></TD><TD><Badge>{member.role}</Badge></TD><TD>{formatDate(member.joinedAt)}</TD></TR>)}</TBody></Table></Card>
    </>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: "success" | "warning" | "danger" }) { return <div><p className="text-xs font-bold uppercase text-[var(--muted)]">{label}</p><Badge tone={tone} className="mt-1">{value}</Badge></div>; }
function Info({ label, value }: { label: string; value: string }) { return <div><p className="text-xs font-bold uppercase text-[var(--muted)]">{label}</p><p className="mt-1 font-semibold">{value}</p></div>; }
function formatDate(value: Date) { return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(value); }
