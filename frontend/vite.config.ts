import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Same location as finanse.core.paths.data_dir() (platformdirs user_data_dir).
function dataDir(): string {
  const override = process.env.FINANSE_DATA_DIR?.trim();
  if (override) return resolve(override.replace(/^~(?=$|[\\/])/, homedir()));
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "finanse");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "finanse");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "finanse");
}

// `finanse serve` writes a fresh token to <data dir>/api-token on every launch;
// read it per request so a restarted backend works without restarting Vite.
function apiToken(): string {
  try {
    return readFileSync(join(dataDir(), "api-token"), "utf8").trim();
  } catch {
    return "";
  }
}

const apiPort = process.env.FINANSE_PORT ?? "8500";

// Dev: `npm run dev` serves the SPA and proxies /api to the FastAPI backend
// (run `finanse serve` alongside), adding the X-Finanse-Token header the backend
// requires. Build: emits into the FastAPI static dir so `finanse serve` alone
// serves the production bundle (the token then arrives via a <meta> tag).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        // Host: 127.0.0.1:<port>, the only kind of Host the backend answers.
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => {
            const token = apiToken();
            if (token) req.setHeader("X-Finanse-Token", token);
          });
        },
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../src/finanse/api/webdist", import.meta.url)),
    emptyOutDir: true,
  },
});
