import { redirect } from "next/navigation";
import { isDemoMode } from "@/lib/demo-mode";
import { getTenantContext } from "@/server/tenant";

export default async function Home() {
  if (isDemoMode()) redirect("/dashboard");
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");
  if ("needsOnboarding" in tenant) redirect("/onboarding");
  redirect("/dashboard");
}
