import withSerwistInit from "@serwist/next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const withSerwist = withSerwistInit({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
  reloadOnOnline: true,
});

/**
 * Response headers every route carries.
 *
 * The app had none, which left three cheap protections on the table. Each is
 * listed with what it actually stops, because a header nobody can explain is a
 * header nobody will dare change later:
 *
 *   * `X-Frame-Options` / `frame-ancestors` — a dashboard framed inside an
 *     attacker's page is the setup for clickjacking a destructive control
 *     ("Discard count", "Remove member") behind a decoy.
 *   * `X-Content-Type-Options` — stops a browser sniffing an uploaded invoice as
 *     HTML and running it as script on this origin.
 *   * `Referrer-Policy` — invitation tokens travel in a URL path
 *     (`/invite/<token>`). Without this, following any off-site link from that
 *     page hands the token to the destination in the `Referer` header.
 *   * `Permissions-Policy` — nothing here needs a camera, a microphone or
 *     geolocation, so the permission prompts are refused outright.
 *
 * A full Content-Security-Policy is deliberately *not* set here. Next.js inlines
 * bootstrap scripts, so a useful policy needs a per-request nonce threaded
 * through the proxy — a real change with real breakage risk, which belongs in
 * its own piece of work rather than smuggled into an audit. `frame-ancestors` is
 * included because it is the one CSP directive that needs no nonce and no
 * allowlist. See the audit report's remaining-work section.
 */
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    optimizePackageImports: ["lucide-react", "recharts"],
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default withSerwist(withNextIntl(nextConfig));
