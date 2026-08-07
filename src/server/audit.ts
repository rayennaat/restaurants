import { getDb } from "@/db/client";
import { auditLogs } from "@/db/schema";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type AuditEntry = {
  organizationId: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Appends to the `audit_logs` table. Auditing must never take down the write it
 * describes, so failures outside a transaction are swallowed and logged.
 * Pass `tx` when the audit row should live or die with the surrounding write.
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
    await tx.insert(auditLogs).values(values);
    return;
  }

  try {
    await getDb().insert(auditLogs).values(values);
  } catch (error) {
    console.error("audit log write failed", error);
  }
}
