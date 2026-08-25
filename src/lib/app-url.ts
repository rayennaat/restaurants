export const LOCAL_APP_URL = "http://localhost:3000";

type AppUrlEnvironment = Readonly<Record<string, string | undefined>>;

export function getAppUrl(env: AppUrlEnvironment = process.env): string {
  const configured = env.NEXT_PUBLIC_APP_URL?.trim();
  return configured ? configured.replace(/\/+$/, "") : LOCAL_APP_URL;
}
