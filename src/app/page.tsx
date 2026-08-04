import { redirect } from "next/navigation";
import { getTenantContext } from "@/server/tenant";

export default async function Home() {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") redirect("/dashboard");
  const tenant = await getTenantContext();
  if (!tenant) redirect("/auth/login");
  if ("needsOnboarding" in tenant) redirect("/onboarding");
  redirect("/dashboard");
}
