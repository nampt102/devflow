import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Served by the DevFlow server at /portal (server/src/app.ts). In dev, /api goes to the local server.
export default defineConfig({
  base: "/portal/",
  plugins: [react()],
  server: { port: 5174, proxy: { "/api": { target: "http://localhost:3100", changeOrigin: false } } },
  build: { outDir: "dist", sourcemap: false },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
