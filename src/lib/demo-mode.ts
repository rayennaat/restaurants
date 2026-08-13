/**
 * The local preview switch.
 *
 * `NEXT_PUBLIC_DEMO_MODE=true` lets the whole UI be browsed with no Supabase
 * project and no database — see the README's "preview immediately" step. It is a
 * development affordance, and this module is where that is made structural
 * rather than a matter of remembering.
 *
 * ## Why it is refused in a production build
 *
 * The flag does not merely hide data; it turns off machinery:
 *
 *   * the proxy stops refreshing the Supabase session,
 *   * `/api/waste` reports success without writing anything,
 *   * `/api/health` answers "ok" without asking the database,
 *   * `/api/invoices/upload-url` hands back a fake path.
 *
 * Any of those reaching real customers is a bad day, and the failure mode of a
 * `NEXT_PUBLIC_*` variable is that it is set once and forgotten — it is baked
 * into the client bundle at build time, so a stale value in a deployment
 * environment is invisible until something is silently not saved.
 *
 * `NODE_ENV` is set by the framework, not by whoever edits the environment:
 * "development" under `next dev`, "production" under `next build`. Gating on it
 * keeps every documented use of the flag working — the dev preview, and the
 * Playwright smoke run, which starts `next dev` — while making "demo mode in
 * production" unrepresentable rather than merely discouraged.
 */
export function isDemoMode(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.NEXT_PUBLIC_DEMO_MODE === "true";
}
