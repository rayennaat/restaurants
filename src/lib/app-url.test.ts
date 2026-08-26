import { describe, expect, it } from "vitest";
import { getAppUrl, LOCAL_APP_URL } from "./app-url";

describe("application URL resolution", () => {
  it("uses the configured production app URL and removes trailing slashes", () => {
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: "https://app.yield.website/" })).toBe("https://app.yield.website");
  });

  it("uses localhost only outside production when the app URL is not configured", () => {
    expect(getAppUrl({})).toBe(LOCAL_APP_URL);
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: "   ", NODE_ENV: "development" })).toBe(LOCAL_APP_URL);
  });

  it("fails explicitly in production when the app URL is not configured", () => {
    expect(() => getAppUrl({ NODE_ENV: "production" })).toThrow("NEXT_PUBLIC_APP_URL must be configured in production.");
    expect(() => getAppUrl({ NEXT_PUBLIC_APP_URL: "   ", NODE_ENV: "production" })).toThrow("NEXT_PUBLIC_APP_URL must be configured in production.");
  });
});
