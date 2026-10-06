import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { proxyAllowed } from "./devProxyGuard";

// CASHU_X, else the pre-rename FINANSE_X (legacy name), like cashu.core.env.env().
const env = (name: string): string | undefined => process.env[`CASHU_${name}`] ?? process.env[`FINANSE_${name}`];

// Same location as cashu.core.paths.data_dir() (platformdirs user_data_dir).
function dataDir(): string {
  const override = env("DATA_DIR")?.trim();
  if (override) return resolve(override.replace(/^~(?=$|[\\/])/, homedir()));
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "cashU");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "cashU");
  }
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "cashu");
}

// `cashu serve` writes a fresh token to <data dir>/api-token on every launch;
// read it per request so a restarted backend works without restarting Vite.
function apiToken(): string {
  try {
    return readFileSync(join(dataDir(), "api-token"), "utf8").trim();
  } catch {
    return "";
  }
}

const apiPort = env("PORT") ?? "8500";

// Refuses cross-site /api requests before Vite's proxy sees them (plugin
// middlewares run before Vite's own): the proxy adds the API token, so without
// this any web page could drive the backend while `npm run dev` runs (CSRF).
function sameOriginApiOnly(): Plugin {
  return {
    name: "cashu-same-origin-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api") || proxyAllowed(req.headers)) return next();
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ detail: "Cross-site request refused by the dev proxy" }));
      });
    },
  };
}

// Dev: `npm run dev` serves the SPA and proxies /api to the FastAPI backend
// (run `cashu serve` alongside), adding the X-Cashu-Token header the backend
// requires, but only to requests that do not name another site (devProxyGuard.ts:
// Origin, Referer and Sec-Fetch-Site must not name another site; others get 403).
// A local client that sends none of these headers (curl) still gets the token
// added: dev only, accepted by the PK1 contract.
// Build: emits into the FastAPI static dir so `cashu serve` alone serves the
// production bundle; the page never carries the token: the desktop window gets
// it from the pywebview bridge, a browser from the one-time `#token=` URL that
// `cashu serve` prints (src/core/token.ts).
export default defineConfig({
  plugins: [react(), sameOriginApiOnly()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        // Host: 127.0.0.1:<port>, the only kind of Host the backend answers.
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            // Second line of defence: never attach the token to a cross-site request.
            const token = apiToken();
            if (token && proxyAllowed(req.headers)) proxyReq.setHeader("X-Cashu-Token", token);
          });
        },
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../src/cashu/api/webdist", import.meta.url)),
    emptyOutDir: true,
  },
});
