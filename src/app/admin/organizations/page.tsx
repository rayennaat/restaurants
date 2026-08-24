import Link from "next/link";
import { Search } from "lucide-react";
import { listPlatformOrganizations, PLAN_LABELS, STATUS_LABELS } from "@/server/queries/platform-admin";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

export default async function AdminOrganizationsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const query = (await searchParams).q?.trim() ?? "";
  const organizations = await listPlatformOrganizations(query);
  return (
    <>
      <PageHeader eyebrow="Platform" title="Organizations" description="Search workspaces and manage platform plan and access state." />
      <form className="mb-5 flex max-w-xl gap-2" method="get">
        <Input name="q" defaultValue={query} placeholder="Search restaurant or slug" aria-label="Search organizations" />
        <Button type="submit" variant="secondary"><Search size={16} aria-hidden="true" /> Search</Button>
      </form>
      <Card className="overflow-hidden">
        <Table className="min-w-[900px]">
          <THead><TR><TH>Restaurant</TH><TH>Owner</TH><TH>Plan</TH><TH>Status</TH><TH>Users</TH><TH>Locations</TH><TH>Created</TH><TH>Last activity</TH></TR></THead>
          <TBody>
            {organizations.length === 0 ? <TR><TD colSpan={8} className="py-8 text-center text-[var(--muted)]">No organizations match this search.</TD></TR> : organizations.map(org => <TR key={org.id}><TD><Link href={`/admin/organizations/${org.id}`} className="font-bold text-green-900 hover:underline">{org.name}</Link></TD><TD>{org.ownerEmail}</TD><TD>{PLAN_LABELS[org.plan]}</TD><TD><Badge tone={org.status === "suspended" || org.status === "cancelled" ? "danger" : org.status === "pilot" ? "warning" : "success"}>{STATUS_LABELS[org.status]}</Badge></TD><TD>{org.users}</TD><TD>{org.locations}</TD><TD>{formatDate(org.createdAt)}</TD><TD>{org.lastActivityAt ? formatDate(org.lastActivityAt) : "No activity"}</TD></TR>)}
          </TBody>
        </Table>
      </Card>
    </>
  );
}

function formatDate(value: Date | string | null | undefined) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(date);
}
