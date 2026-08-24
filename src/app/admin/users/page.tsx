import { Search } from "lucide-react";
import { listPlatformUsers } from "@/server/queries/platform-admin";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const query = (await searchParams).q?.trim() ?? "";
  const users = await listPlatformUsers(query);
  return <>
    <PageHeader eyebrow="Platform" title="Users" description="Search application users, verification state, organization memberships and roles." />
    <form className="mb-5 flex max-w-xl gap-2" method="get"><Input name="q" defaultValue={query} placeholder="Search email or user ID" aria-label="Search users" /><Button type="submit" variant="secondary"><Search size={16} aria-hidden="true" /> Search</Button></form>
    <Card className="overflow-hidden"><Table className="min-w-[900px]"><THead><TR><TH>Email</TH><TH>Verification</TH><TH>Organization</TH><TH>Role</TH><TH>Account</TH><TH>Last seen</TH></TR></THead><TBody>{users.length === 0 ? <TR><TD colSpan={6} className="py-8 text-center text-[var(--muted)]">No users match this search.</TD></TR> : users.map(user => <TR key={`${user.userId}-${user.organizationId ?? "none"}`}><TD><div className="font-semibold">{user.email || "Unavailable"}</div><div className="mt-1 font-mono text-[10px] text-[var(--muted)]">{user.userId}</div></TD><TD><Badge tone={user.emailConfirmedAt ? "success" : "warning"}>{user.emailConfirmedAt ? "Verified" : "Unverified"}</Badge></TD><TD>{user.organizationName ?? "No organization"}</TD><TD>{user.role ? <Badge>{user.role}</Badge> : "—"}</TD><TD>{user.status}</TD><TD>{user.lastSeenAt ? formatDate(user.lastSeenAt) : "—"}</TD></TR>)}</TBody></Table></Card>
  </>;
}

function formatDate(value: Date) { return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(value); }
