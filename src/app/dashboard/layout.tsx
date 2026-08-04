import { redirect } from "next/navigation";
import { Sidebar } from "@/components/dashboard/sidebar";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { getTenantContext } from "@/server/tenant";
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const tenant = await getTenantContext(); if (!tenant) redirect("/auth/login"); if ("needsOnboarding" in tenant) redirect("/onboarding");
  return <div className="flex min-h-screen"><Sidebar organizationName={tenant.organizationName}/><main className="min-w-0 flex-1 p-4 pb-28 sm:p-7 lg:p-10 lg:pb-10">{children}</main><MobileNav/></div>;
}
