import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/douyin",
  workers: 1,
  timeout: 45000,
  use: {
    ...devices["Desktop Chrome"],
    channel: "chrome",
    baseURL: "http://127.0.0.1:5177",
    viewport: { width: 1440, height: 940 },
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command:
        "corepack pnpm --dir apps/desktop dev --host 127.0.0.1 --port 5177 --strictPort",
      env: { VITE_API_MODE: "live" },
      url: "http://127.0.0.1:5177",
      reuseExistingServer: false,
    },
    {
      command:
        "corepack pnpm --dir apps/admin dev --host 127.0.0.1 --port 5178 --strictPort",
      env: { VITE_API_MODE: "live" },
      url: "http://127.0.0.1:5178",
      reuseExistingServer: false,
    },
  ],
});
