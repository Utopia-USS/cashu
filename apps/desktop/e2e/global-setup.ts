/// <reference types="node" />
// Seeds a temp demo data dir (never a real one), exports the isolation and the paths the Electron
// fixture needs, and removes everything afterwards. Mirrors frontend/e2e/global-setup.ts.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DIR, REPO } from "./prepare-specs.ts";

const require = createRequire(import.meta.url);

export default async function globalSetup() {
  const python = join(REPO, ".venv", "bin", "python");
  const webdist = join(REPO, "src", "cashu", "api", "webdist", "index.html");
  const main = join(APP_DIR, "dist", "main.js");
  if (!existsSync(webdist))
    throw new Error(`No built SPA at ${webdist}: run \`npm run build\` in frontend/ first.`);
  if (!existsSync(python)) throw new Error(`No virtualenv at ${python}.`);
  if (!existsSync(main))
    throw new Error(`No build at ${main}: run \`pnpm --filter @cashu/desktop build\` first.`);

  const root = realpathSync(mkdtempSync(join(tmpdir(), "cashu-e2e-desktop-")));
  // legacy name: drop every pre-rename FINANSE_* variable, as frontend/e2e/global-setup.ts does
  for (const key of Object.keys(process.env))
    if (key.startsWith("FINANSE_")) delete process.env[key];
  mkdirSync(join(root, "home"));
  const isolation = {
    CASHU_TESTING: "1",
    HOME: join(root, "home"),
    CASHU_DATA_DIR: join(root, "data"),
    CASHU_LEGACY_DATA_DIR: join(root, "legacy-default-data-dir"),
    CASHU_WORKSPACES_DIR: join(root, "workspaces"),
    CASHU_LAUNCH_AGENTS_DIR: join(root, "LaunchAgents"),
    CASHU_APP_BUNDLE: "none",
    CASHU_AUTO_DAILY: "0",
    PYTHON_KEYRING_BACKEND: "memory_keyring.MemoryKeyring",
    PYTHONPATH: [join(REPO, "frontend", "e2e"), process.env.PYTHONPATH].filter(Boolean).join(":"),
  };
  Object.assign(process.env, isolation);
  delete process.env.CASHU_DATABASE_URL;

  // Fail-safe: the data dir the sidecar resolves must be the temp one.
  const check = spawnSync(python, ["-c", "from cashu.core import paths; print(paths.data_dir())"], {
    env: process.env,
    encoding: "utf8",
  });
  if (check.stdout.trim() !== isolation.CASHU_DATA_DIR) {
    throw new Error(
      `The sidecar would use ${check.stdout.trim()}, not ${isolation.CASHU_DATA_DIR}`,
    );
  }
  const seed = spawnSync(
    python,
    [join(REPO, "scripts", "demo_data.py"), "--data-dir", isolation.CASHU_DATA_DIR],
    {
      env: process.env,
      encoding: "utf8",
    },
  );
  if (seed.status !== 0) throw new Error(`demo_data.py failed:\n${seed.stdout}\n${seed.stderr}`);

  process.env.E2E_ROOT = root;
  process.env.E2E_DATA_DIR = isolation.CASHU_DATA_DIR;
  process.env.E2E_APP_DIR = APP_DIR;
  process.env.E2E_REPO = REPO;
  process.env.E2E_ELECTRON = require("electron") as string;
  process.env.E2E_PYTHON = python;
  process.env.E2E_SERVE_OFFLINE = join(REPO, "frontend", "e2e", "serve_offline.py");
  // The specs' own CLI calls (18-connectors) use the same memory keyring, never the login keychain.
  process.env.E2E_PYTHON_KEYRING_BACKEND = isolation.PYTHON_KEYRING_BACKEND;
  process.env.E2E_PYTHONPATH = isolation.PYTHONPATH;

  return async () => {
    if (process.env.E2E_KEEP === "1") process.stderr.write(`kept ${root}\n`);
    else rmSync(root, { recursive: true, force: true });
  };
}
