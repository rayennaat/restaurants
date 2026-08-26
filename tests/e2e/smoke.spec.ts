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
