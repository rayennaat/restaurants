/**
 * Validating a redirect destination that arrived from a URL.
 *
 * Sign-in and the auth callback both carry a `?next=` so an invited employee
 * lands back on the invitation they came from instead of on workspace creation.
 * That parameter is attacker-controllable and ends up in a navigation, which
 * makes it an open-redirect candidate: a link on the real domain that quietly
 * finishes on somebody else's, which is what makes credential phishing
 * convincing.
 *
 * Pure and dependency-free so the whole rule can be asserted in unit tests, and
 * so the browser form and the server route can share one definition rather than
 * two similar-looking ones.
 *
 * ## Why `startsWith("/") && !startsWith("//")` was not enough
 *
 * That was the previous rule, and two shapes slip through it — both verified
 * against the WHATWG URL parser that browsers and `next/navigation` use:
 *
 *   new URL("/\\evil.com",   "https://app.example") → https://evil.com/
 *   new URL("/\t/evil.com",  "https://app.example") → https://evil.com/
 *
 * The first exploits backslash being equivalent to `/` in a special-scheme URL,
 * so `/\` is read as an authority delimiter. The second exploits tabs, newlines
 * and carriage returns being *stripped before parsing*, so `/%09/evil.com` —
 * which `searchParams.get()` hands back with a real tab — collapses into
 * `//evil.com`. Both start with a single slash and neither starts with `//`.
 *
 * So the rule is a whitelist instead: one leading slash, no second slash, no
 * backslash anywhere, and nothing in the C0 control range or a space, which is
 * exactly the set of characters a URL parser is permitted to remove or reinterpret.
 */

/** Characters a URL parser strips or rewrites, so they may never be trusted. */
// C0 controls and space — tab, newline and carriage return live in that range
// and are removed *before* parsing — plus DEL, plus the backslash that a
// special-scheme parser reads as a slash.
const UNSAFE_IN_PATH = /[\u0000-\u0020\u007f\\]/;

/**
 * Returns `value` when it is a safe same-origin path, otherwise `null`.
 *
 * "Same-origin path" means it will resolve against the current origin and cannot
 * name a different host, whether it is concatenated onto an origin server-side
 * or resolved relatively by the client router.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  // `//host` is protocol-relative; `/\host` becomes the same thing once the
  // parser normalizes the backslash.
  if (value.startsWith("//")) return null;
  if (UNSAFE_IN_PATH.test(value)) return null;
  return value;
}

/**
 * Same rule, with a destination for the common case of "there was nothing usable
 * in the URL". Callers that must redirect somewhere use this; callers that can
 * fall back to their own default use {@link safeNextPath}.
 */
export function safeNextPathOr(value: string | null | undefined, fallback: string): string {
  return safeNextPath(value) ?? fallback;
}
