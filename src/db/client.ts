import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
let cached: PostgresJsDatabase<typeof schema> | undefined;
export function getDb() {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured.");
  const client = postgres(url, { prepare: false, max: 5, idle_timeout: 20 });
  cached = drizzle(client, { schema });
  return cached;
}
