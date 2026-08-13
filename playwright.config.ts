import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  timeout: 90_000,
  use: { baseURL, trace: "on-first-retry" },
  webServer: {
    command: `NEXT_PUBLIC_DEMO_MODE=true NEXT_DIST_DIR=.next-playwright npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }
  ],
});
