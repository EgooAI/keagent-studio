import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import manifest from "../../package.json" with { type: "json" };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  define: {
    __DESKTOP_RELEASE_NOTES__: JSON.stringify(
      readFileSync(
        new URL(
          `../../docs/desktop-releases/${manifest.version}.md`,
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  },
  envDir: "../..",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:18080",
    },
  },
  build: {
    chunkSizeWarningLimit: 1800,
  },
});
