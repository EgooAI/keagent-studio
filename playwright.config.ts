import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "pnpm dev:web",
      env: { VITE_API_MODE: "mock" },
      url: "http://127.0.0.1:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: "pnpm dev:admin",
      env: { VITE_API_MODE: "mock" },
      url: "http://127.0.0.1:5174",
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
  ],
});
