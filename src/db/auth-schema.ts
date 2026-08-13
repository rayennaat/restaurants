import { jsonb, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * A read-only handle on Supabase's `auth.users`.
 *
 * Supabase keeps its auth tables in the same PostgreSQL database as the
 * application schema, and the server connects as `postgres`, so a plain join
 * reaches them. That is how the team screen resolves a `user_id` into a name
 * and an email without duplicating identity onto `organization_members` — a
 * copy would go stale the moment somebody changed their address.
 *
 * This file is deliberately NOT referenced by `drizzle.config.ts`, whose
 * `schema` points at `db/schema.ts` alone. Were these definitions visible to
 * drizzle-kit, `generate` would treat Supabase's own table as application
 * schema and emit DDL to create or drop it.
 *
 * Treat every column here as read-only. Users are created and modified through
 * Supabase Auth, never by this application.
 */
const authSchema = pgSchema("auth");

export const authUsers = authSchema.table("users", {
  id: uuid("id").primaryKey(),
  email: text("email"),
  /** Sign-up metadata. `full_name` lands here when a provider supplies it. */
  rawUserMetaData: jsonb("raw_user_meta_data"),
  emailConfirmedAt: timestamp("email_confirmed_at", { withTimezone: true }),
  lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }),
});

/** Best-effort display name from sign-up metadata; falls back to the caller's default. */
export function displayNameFrom(metadata: unknown, fallback: string): string {
  if (metadata && typeof metadata === "object") {
    const record = metadata as Record<string, unknown>;
    for (const key of ["full_name", "name", "user_name"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return fallback;
}
