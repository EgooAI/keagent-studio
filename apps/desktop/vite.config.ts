import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
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
