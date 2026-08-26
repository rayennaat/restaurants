import { redirect } from "next/navigation";
import { eq, and } from "drizzle-orm";
import { getDb } from "@/db/client";
import { platformAdmins, userProfiles } from "@/db/schema";
import { createClient } from "@/lib/supabase/server";
import { ActionError } from "@/lib/action-error";

export type PlatformAdmin = {
  userId: string;
  email: string | null;
};

export async function getPlatformAdmin(): Promise<PlatformAdmin | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const [admin] = await getDb()
    .select({ userId: platformAdmins.userId })
    .from(platformAdmins)
    .leftJoin(userProfiles, eq(userProfiles.userId, platformAdmins.userId))
    .where(and(eq(platformAdmins.userId, user.id), eq(platformAdmins.active, true), eq(userProfiles.status, "active")))
    .limit(1);

  return admin ? { userId: user.id, email: user.email ?? null } : null;
}

export async function requirePlatformAdmin(): Promise<PlatformAdmin> {
  const admin = await getPlatformAdmin();
  if (!admin) redirect("/auth/login?next=/admin");
  return admin;
}

export async function requirePlatformAdminAction(): Promise<PlatformAdmin> {
  const admin = await getPlatformAdmin();
  if (!admin) throw new ActionError("You do not have platform administration access.");
  return admin;
}
