import { describe, expect, it } from "vitest";
import { getAppUrl, LOCAL_APP_URL } from "./app-url";

describe("application URL resolution", () => {
  it("uses the configured production app URL and removes trailing slashes", () => {
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: "https://app.yield.website/" })).toBe("https://app.yield.website");
  });

  it("uses localhost only when the app URL is not configured", () => {
    expect(getAppUrl({})).toBe(LOCAL_APP_URL);
    expect(getAppUrl({ NEXT_PUBLIC_APP_URL: "   " })).toBe(LOCAL_APP_URL);
  });
});
