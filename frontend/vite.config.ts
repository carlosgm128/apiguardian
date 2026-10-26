import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Dev: `npm run dev:web` serves on :5173 and proxies /api to `apiguardian serve` on :4319.
// Build: emits to dist/web, which the server serves.
// Demo (`--mode demo`): a static build in dist/demo that needs no server (see src/demo).
export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  base: mode === "demo" ? "./" : "/",
  build: {
    outDir: fileURLToPath(new URL(mode === "demo" ? "../dist/demo" : "../dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: mode === "demo" ? undefined : { "/api": "http://127.0.0.1:4319" },
  },
}));
