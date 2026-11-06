import { defineConfig } from "vite";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      "@keagent/shared-types": fileURLToPath(
        new URL("./packages/shared-types/src/index.ts", import.meta.url),
      ),
    },
  },
  build: {
    target: "node22",
    outDir: "apps/desktop/electron/publishing/dist",
    emptyOutDir: true,
    lib: {
      entry: "apps/desktop/electron/publishing/index.ts",
      formats: ["cjs"],
      fileName: () => "runtime.cjs",
    },
    rollupOptions: {
      external: [
        "electron",
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
      ],
    },
  },
});
