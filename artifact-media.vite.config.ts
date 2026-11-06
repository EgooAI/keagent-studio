import { defineConfig } from "vite";
import { builtinModules } from "node:module";
export default defineConfig({
  build: {
    target: "node22",
    outDir: "apps/desktop/electron/artifact-media/dist",
    emptyOutDir: true,
    lib: {
      entry: "apps/desktop/electron/artifact-media/index.ts",
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
