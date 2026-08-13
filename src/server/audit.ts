import { getDb } from "@/db/client";
import { auditLogs } from "@/db/schema";
import type { AuditAction, AuditEntityType } from "@/lib/audit-actions";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type AuditEntry = {
  organizationId: string;
  userId: string | null;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Appends to the `audit_logs` table.
 *
 * There are deliberately two durability modes, and the choice of which to use
 * is a judgement about what the record is worth:
 *
 * **Pass `tx` for anything security- or money-relevant.** The audit row then
 * lives or dies with the change it describes. A member removal, a role change,
 * an approved stock count or a deletion must never be able to succeed while its
 * record quietly fails — that is precisely the case an audit log exists for.
 *
 * **Omit `tx` for routine catalog edits.** Failures are swallowed and logged,
 * so a transient problem writing the trail cannot stop somebody renaming an
 * ingredient. Losing that row is regrettable; blocking the kitchen is worse.
 *
 * When in doubt, pass `tx`. The cost is one statement inside a transaction that
 * is already open.
 */
export async function recordAudit(entry: AuditEntry, tx?: Tx) {
  const values = {
    organizationId: entry.organizationId,
    userId: entry.userId,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
  };

  if (tx) {
    // Intentionally unguarded: a failure here must roll back the caller's write.
    await tx.insert(auditLogs).values(values);
    return;
  }

  try {
    await getDb().insert(auditLogs).values(values);
  } catch (error) {
    console.error("audit log write failed", error);
  }
}
