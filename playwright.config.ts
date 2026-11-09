import { defineConfig, devices } from "@playwright/test";

const mockDesktop = "http://127.0.0.1:5184";
const liveDesktop = "http://127.0.0.1:5183";
const factorySpecs = "**/factory-settings.spec.ts";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "browser-mock",
      testIgnore: factorySpecs,
      use: { baseURL: mockDesktop },
    },
    {
      name: "factory-desktop-bridge",
      testMatch: factorySpecs,
      use: { baseURL: liveDesktop },
    },
  ],
  webServer: [
    {
      command:
        "pnpm --filter @keagent/desktop exec vite --host 127.0.0.1 --port 5184 --strictPort",
      env: { VITE_API_MODE: "mock" },
      url: mockDesktop,
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command:
        "pnpm --filter @keagent/desktop exec vite --host 127.0.0.1 --port 5183 --strictPort",
      env: { VITE_API_MODE: "live" },
      url: liveDesktop,
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
