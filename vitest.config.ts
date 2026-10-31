import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    environment: "node",
    env: { VITE_API_MODE: "mock" },
  },
  resolve: {
    alias: {
      "@keagent/shared-types": fileURLToPath(
        new URL("./packages/shared-types/src/index.ts", import.meta.url),
      ),
    },
  },
});
