import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getDb } from "@/db/client";
import { isDemoMode } from "@/lib/demo-mode";

/**
 * Liveness probe.
 *
 * Unauthenticated by design — a load balancer cannot sign in — which is exactly
 * why the response says as little as it possibly can. It used to return
 * `current_database()` and, on failure, the driver's own message: between them
 * that discloses the database name, the pooler host and whether authentication
 * or DNS was at fault, to anyone who can reach the URL.
 *
 * What a health check actually needs to answer is "can this instance serve
 * requests": one boolean, plus a reference an operator can grep for in the logs
 * where the detail is safe to keep.
 */
export async function GET() {
  if (isDemoMode()) {
    return NextResponse.json({ ok: true, mode: "demo" });
  }

  try {
    await getDb().execute(sql`select 1`);
    return NextResponse.json({ ok: true, mode: "database" });
  } catch (error) {
    const reference = randomUUID().slice(0, 8);
    console.error(`health check failed [${reference}]`, error);
    return NextResponse.json({ ok: false, reference }, { status: 503 });
  }
}
