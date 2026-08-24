import { listPlatformAuditLogs } from "@/server/queries/platform-admin";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";

export default async function AdminAuditPage() {
  const entries = await listPlatformAuditLogs();
  return <><PageHeader eyebrow="Platform" title="Admin audit log" description="Immutable administrative events for onboarding and organization access metadata." /><Card className="overflow-hidden"><Table className="min-w-[850px]"><THead><TR><TH>Time</TH><TH>Action</TH><TH>Organization</TH><TH>Entity</TH><TH>Actor</TH></TR></THead><TBody>{entries.length === 0 ? <TR><TD colSpan={5} className="py-8 text-center text-[var(--muted)]">No platform actions recorded.</TD></TR> : entries.map(entry => <TR key={entry.id}><TD>{formatDate(entry.createdAt)}</TD><TD className="font-semibold">{entry.action.replaceAll("_", " ")}</TD><TD>{entry.organizationId ?? "Platform"}</TD><TD>{entry.entityId ?? "—"}</TD><TD className="font-mono text-xs">{entry.actorUserId}</TD></TR>)}</TBody></Table></Card></>;
}

function formatDate(value: Date) { return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(value); }
