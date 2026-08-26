import { test, expect } from "@playwright/test";

test("login surface is available before authentication", async ({ page }) => {
  await page.goto("/auth/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Password" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
});

test("demo health check does not require a database", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toMatchObject({ ok: true, mode: "demo" });
});


test("owner verification callback preserves the onboarding token", async ({ request }) => {
  const token = "owner-token-e2e";
  const next = `/onboarding/${token}`;
  const response = await request.get(`/auth/callback?next=${encodeURIComponent(next)}`, { maxRedirects: 0 });
  expect(response.status()).toBeGreaterThanOrEqual(300);
  expect(response.status()).toBeLessThan(400);
  const location = response.headers().location;
  expect(location).toBeTruthy();
  const redirectUrl = new URL(location!);
  expect(redirectUrl.pathname).toBe(`/onboarding/${token}`);
  expect(redirectUrl.pathname).not.toBe("/onboarding");
});
