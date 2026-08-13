import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { getTenantContext } from "@/server/tenant";

/**
 * The shell every dashboard screen renders inside.
 *
 * Two navigations, one model: {@link Sidebar} on `lg` and up, {@link MobileNav}
 * below it. Each hides itself at the other's breakpoint, so exactly one is ever
 * visible and there is no duplicate landmark for a screen reader to announce.
 *
 * The mobile bar is a sticky header rather than the fixed bottom bar it
 * replaced, which is why `main` no longer carries the tall bottom padding that
 * used to keep content clear of it.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");
  if ("needsOnboarding" in tenant) redirect("/onboarding");

  return (
    <div className="lg:flex lg:min-h-screen">
      <Sidebar organizationName={tenant.organizationName} />
      <MobileNav organizationName={tenant.organizationName} />
      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8 xl:p-10">{children}</main>
    </div>
  );
}
