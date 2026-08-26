import { createClient, type User } from "@supabase/supabase-js";

export type AdminAuthUser = {
  id: string;
  email: string | null;
  emailConfirmedAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date | null;
};

function dateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeAdminUser(user: User): AdminAuthUser {
  return {
    id: user.id,
    email: user.email ?? null,
    emailConfirmedAt: dateOrNull(user.email_confirmed_at),
    lastSeenAt: dateOrNull(user.last_sign_in_at),
    createdAt: dateOrNull(user.created_at),
  };
}

export function hasAdminServiceRole() {
  return Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function listAdminAuthUsers(): Promise<AdminAuthUser[]> {
  const supabase = createAdminClient();
  const users: AdminAuthUser[] = [];
  const perPage = 1000;

  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const batch = data.users.map(normalizeAdminUser);
    users.push(...batch);
    if (batch.length < perPage) break;
  }

  return users;
}

export async function getAdminAuthUserById(userId: string): Promise<AdminAuthUser | null> {
  const { data, error } = await createAdminClient().auth.admin.getUserById(userId);
  if (error) {
    if (error.status === 404) return null;
    throw error;
  }
  return data.user ? normalizeAdminUser(data.user) : null;
}
