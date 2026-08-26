export const LOCAL_APP_URL = "http://localhost:3000";

type AppUrlEnvironment = Readonly<Record<string, string | undefined>>;

export function getAppUrl(env: AppUrlEnvironment = process.env): string {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (env.NODE_ENV === "production") {
    throw new Error("NEXT_PUBLIC_APP_URL must be configured in production.");
  }
  return LOCAL_APP_URL;
}
