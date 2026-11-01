// Dev run of the Electron shell on DEMO data only (never the owner's real data):
//   pnpm --filter @cashu/desktop dev
// Seed the demo data dir first (once, never with --force):
//   .venv/bin/python scripts/demo_data.py --data-dir ~/cashu-lab/desktop-demo
// A page that asks for a store port gets one relayed to the data dir's local host (apps/host), started
// on demand on a synthetic demo vault in <data dir>/stores; it lingers while idle, then exits by itself
// (`node --import tools/node-ts/resolveTs.ts apps/host/src/cli.ts stop --data-dir <dir>` stops it).
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const lab = join(homedir(), "cashu-lab");

const env = {
  ...process.env,
  CASHU_DATA_DIR: process.env.CASHU_DATA_DIR || join(lab, "desktop-demo"),
  CASHU_WORKSPACES_DIR: process.env.CASHU_WORKSPACES_DIR || join(lab, "desktop-demo-ws"),
  CASHU_AUTO_DAILY: "0",
  // The shell refuses a data dir outside this folder.
  CASHU_DESKTOP_ALLOWED_DATA_ROOT: process.env.CASHU_DESKTOP_ALLOWED_DATA_ROOT || lab,
  // Connector secrets stay out of the login keychain in dev runs.
  PYTHON_KEYRING_BACKEND: process.env.PYTHON_KEYRING_BACKEND || "keyring.backends.null.Keyring",
};

const build = spawnSync("pnpm", ["run", "build"], { cwd: app, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const child = spawn(electron, [app, ...process.argv.slice(2)], { env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
