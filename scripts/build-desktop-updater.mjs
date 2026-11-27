import { build } from "vite";
import { builtinModules } from "node:module";
await build({
  configFile: false,
  build: {
    target: "node22",
    outDir: "output/desktop-updater",
    lib: {
      entry: "scripts/desktop-updater-entry.cjs",
      formats: ["cjs"],
      fileName: () => "runtime.cjs",
    },
    rollupOptions: { external: ["electron", ...builtinModules, /^node:/] },
  },
});
