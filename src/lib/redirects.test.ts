import { describe, expect, it } from "vitest";
import { safeNextPath, safeNextPathOr } from "@/lib/redirects";

/**
 * Open-redirect regression tests.
 *
 * Unlike most of the security suite these call the real function with the real
 * payloads, because the rule is pure string handling and the exploit is a string.
 *
 * Each rejected case below is a URL that the previous rule — "starts with a
 * slash, is not `//`" — accepted, and that the WHATWG URL parser resolves to a
 * different origin. The assertions on `new URL(...)` are deliberate: they pin the
 * parser behaviour that makes each payload dangerous, so if a future reader
 * doubts that `/\evil.com` is really off-origin, the test answers rather than
 * argues.
 */

const ORIGIN = "https://app.example";

/** Where a browser or the Next router would actually land for a given `next`. */
const resolves = (value: string) => new URL(value, `${ORIGIN}/auth/login`).origin;

describe("safeNextPath accepts same-origin paths", () => {
  it("accepts a plain path", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
  });

  it("accepts the invitation path an invited employee returns to", () => {
    // Tokens are base64url, so this is the real shape of the redirect that
    // matters most: it is the one carrying a credential.
    expect(safeNextPath("/invite/xK3-9_aZq0")).toBe("/invite/xK3-9_aZq0");
  });

  it("accepts a path with a query string and a fragment", () => {
    expect(safeNextPath("/dashboard/sales?range=30d&location=all#top")).toBe("/dashboard/sales?range=30d&location=all#top");
  });

  it("accepts a percent-encoded segment", () => {
    expect(safeNextPath("/dashboard/reports?label=Caf%C3%A9")).toBe("/dashboard/reports?label=Caf%C3%A9");
  });
});

describe("safeNextPath rejects anything that can leave the origin", () => {
  it("rejects a protocol-relative host", () => {
    expect(resolves("//evil.example")).not.toBe(ORIGIN);
    expect(safeNextPath("//evil.example")).toBeNull();
  });

  it("rejects a backslash authority, which a special-scheme parser reads as //", () => {
    // The first shape the old rule let through.
    expect(resolves("/\\evil.example")).not.toBe(ORIGIN);
    expect(safeNextPath("/\\evil.example")).toBeNull();
    expect(safeNextPath("/\\/evil.example")).toBeNull();
  });

  it("rejects a tab, which is stripped before parsing and collapses into //", () => {
    // The second shape, and the subtler one: `?next=/%09/evil.example` arrives
    // from `searchParams.get()` as a real tab character.
    expect(resolves("/\t/evil.example")).not.toBe(ORIGIN);
    expect(safeNextPath("/\t/evil.example")).toBeNull();
  });

  it("rejects newlines and carriage returns for the same reason", () => {
    expect(safeNextPath("/\n/evil.example")).toBeNull();
    expect(safeNextPath("/\r/evil.example")).toBeNull();
  });

  it("rejects an absolute URL, with or without a scheme", () => {
    expect(safeNextPath("https://evil.example")).toBeNull();
    expect(safeNextPath("//evil.example/dashboard")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
  });

  it("rejects a relative path that does not start at the root", () => {
    // `dashboard` would resolve against the current directory, which is not what
    // any caller means and not something worth supporting.
    expect(safeNextPath("dashboard")).toBeNull();
  });

  it("rejects empty and missing values", () => {
    expect(safeNextPath("")).toBeNull();
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
  });
});

describe("safeNextPathOr", () => {
  it("returns the fallback for every rejected shape", () => {
    for (const rejected of ["//evil.example", "/\\evil.example", "/\t/evil.example", "https://evil.example", "", null]) {
      expect(safeNextPathOr(rejected, "/onboarding")).toBe("/onboarding");
    }
  });

  it("returns the path when it is safe", () => {
    expect(safeNextPathOr("/invite/abc", "/onboarding")).toBe("/invite/abc");
  });

  it("keeps the auth callback on its own origin for every payload", () => {
    // The callback builds `${origin}${next}`. Concatenation already contained the
    // host, so this asserts the property that matters rather than the mechanism:
    // whatever comes back, the redirect stays here.
    for (const payload of ["/dashboard", "//evil.example", "/\\evil.example", "/\t/evil.example", "javascript:alert(1)"]) {
      const destination = `${ORIGIN}${safeNextPathOr(payload, "/onboarding")}`;
      expect(new URL(destination).origin).toBe(ORIGIN);
    }
  });
});
