import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { platformAdmins } from "../src/db/schema";

const USAGE = "Usage: npm run platform-admin:set -- user-uuid [disable]";

async function main() {
  const [, , userId, operation] = process.argv;
  if (userId === "--help" || userId === "-h") {
    console.log(`${USAGE}\n\nRequired arguments:\n  user-uuid  Supabase Auth user UUID to add to or disable in the platform-admin allowlist.\n  disable    Optional. Mark the existing platform-admin row inactive.`);
    return;
  }
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) throw new Error(USAGE);
  config({ path: process.env.DB_ENV === "staging" ? ".env.staging" : ".env.local", override: true });
  const db = getDb();
  if (operation === "disable") {
    await db.update(platformAdmins).set({ active: false, updatedAt: new Date() }).where(eq(platformAdmins.userId, userId));
    console.log(`Platform admin disabled: ${userId}`);
    return;
  }
  await db.insert(platformAdmins).values({ userId, active: true }).onConflictDoUpdate({ target: platformAdmins.userId, set: { active: true, updatedAt: new Date() } });
  console.log(`Platform admin enabled: ${userId}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Platform admin update failed.");
  process.exitCode = 1;
});
