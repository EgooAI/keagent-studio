import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  envDir: "../..",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:18080",
    },
  },
  publicDir: "../desktop/public",
  build: { chunkSizeWarningLimit: 1800 },
});
