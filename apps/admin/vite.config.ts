import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  envDir: "../..",
  publicDir: "../desktop/public",
  build: { chunkSizeWarningLimit: 1800 },
});
