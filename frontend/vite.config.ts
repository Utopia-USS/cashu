import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Dev: `npm run dev` serves the SPA and proxies /api to the FastAPI backend
// (run `finanse serve` on :8500 alongside). Build: emits into the FastAPI static
// dir so `finanse serve` alone serves the production bundle.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8500" },
  },
  build: {
    outDir: fileURLToPath(new URL("../src/finanse/api/webdist", import.meta.url)),
    emptyOutDir: true,
  },
});
