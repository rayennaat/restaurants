import Dexie, { type EntityTable } from "dexie";
export type PendingOperation = { id: string; endpoint: string; method: "POST" | "PATCH" | "DELETE"; body: unknown; createdAt: number; attempts: number };
class OfflineDatabase extends Dexie { operations!: EntityTable<PendingOperation, "id">; constructor() { super("platepilot-offline"); this.version(1).stores({ operations: "id, createdAt, attempts" }); } }
export const offlineDb = typeof window === "undefined" ? null : new OfflineDatabase();
export async function submitOrQueue(endpoint: string, body: unknown) {
  const id = crypto.randomUUID();
  const payload = { ...((body as object) ?? {}), clientOperationId: id };
  if (navigator.onLine) {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (response.ok) return { queued: false, response: await response.json() };
  }
  await offlineDb?.operations.add({ id, endpoint, method: "POST", body: payload, createdAt: Date.now(), attempts: 0 });
  return { queued: true };
}
export async function syncPendingOperations() {
  if (!offlineDb || !navigator.onLine) return;
  const operations = await offlineDb.operations.orderBy("createdAt").toArray();
  for (const operation of operations) {
    try {
      const response = await fetch(operation.endpoint, { method: operation.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation.body) });
      if (response.ok || response.status === 409) await offlineDb.operations.delete(operation.id);
      else await offlineDb.operations.update(operation.id, { attempts: operation.attempts + 1 });
    } catch { await offlineDb.operations.update(operation.id, { attempts: operation.attempts + 1 }); }
  }
}
