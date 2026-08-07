import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    // Playwright owns tests/e2e; without this Vitest also collects those specs
    // and fails on `test()` being called outside a Playwright runner.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "tests/e2e/**"],
  },
  resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
});
