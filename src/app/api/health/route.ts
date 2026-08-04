import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";

export async function GET() {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
    return NextResponse.json({ ok: true, mode: "demo", database: "not required" });
  }

  try {
    const db = getDb();
    const result = await db.execute(sql`select current_database() as database, now() as checked_at`);
    return NextResponse.json({ ok: true, mode: "database", result: result[0] });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Database connection failed" },
      { status: 503 },
    );
  }
}
