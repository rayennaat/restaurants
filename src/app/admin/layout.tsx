import { AdminShell } from "@/components/admin/admin-shell";
import { requirePlatformAdmin } from "@/server/platform-admin";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformAdmin();
  return <AdminShell>{children}</AdminShell>;
}
