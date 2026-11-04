/// <reference types="node" />
// Seeds synthetic native stores in an isolated temp root and removes them afterwards.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeHarnessScript } from "./electron-test.ts";
import { APP_DIR, REPO } from "./prepare-specs.ts";

const require = createRequire(import.meta.url);

export default async function globalSetup() {
  const python = join(REPO, ".venv", "bin", "python");
  const renderer = join(APP_DIR, "dist", "renderer", "index.html");
  const main = join(APP_DIR, "dist", "main.js");
  if (!existsSync(renderer))
    throw new Error(`No native renderer at ${renderer}: build @cashu/desktop first.`);
  if (!existsSync(python)) throw new Error(`No virtualenv at ${python}.`);
  if (!existsSync(main))
    throw new Error(`No build at ${main}: run \`pnpm --filter @cashu/desktop build\` first.`);

  const tempRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const root = realpathSync(mkdtempSync(join(tempRoot, "cashu-e2e-desktop-")));
  process.env.E2E_ROOT = root;
  // Drop pre-rename environment variables before any Python process starts.
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
    TMPDIR: tempRoot,
    PYTHON_KEYRING_BACKEND: "memory_keyring.MemoryKeyring",
    PYTHONPATH: [join(REPO, "frontend", "e2e"), join(REPO, "src"), process.env.PYTHONPATH]
      .filter(Boolean)
      .join(":"),
  };
  Object.assign(process.env, isolation);
  delete process.env.CASHU_DATABASE_URL;

  // Fail-safe: Python fixture generation must resolve the isolated data dir before imports.
  const check = spawnSync(python, ["-c", "from cashu.core import paths; print(paths.data_dir())"], {
    env: process.env,
    encoding: "utf8",
  });
  if (check.stdout.trim() !== isolation.CASHU_DATA_DIR) {
    throw new Error(
      `The fixture would use ${check.stdout.trim()}, not ${isolation.CASHU_DATA_DIR}`,
    );
  }
  const seed = spawnSync(
    python,
    [
      join(APP_DIR, "e2e", "seed-demo.py"),
      join(REPO, "scripts", "demo_data.py"),
      "--data-dir",
      isolation.CASHU_DATA_DIR,
    ],
    {
      env: process.env,
      encoding: "utf8",
    },
  );
  if (seed.status !== 0) throw new Error(`demo_data.py failed:\n${seed.stdout}\n${seed.stderr}`);

  const oracle = spawnSync(python, [join(APP_DIR, "e2e", "overview-oracle.py")], {
    env: process.env,
    encoding: "utf8",
  });
  if (oracle.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`isolated Overview oracle failed: ${oracle.stderr}`);
  }
  process.env.E2E_OVERVIEW_ORACLE = join(root, "overview-oracle.json");

  process.env.E2E_ROOT = root;
  process.env.E2E_NATIVE_DATA_DIR = join(root, "native-data");
  // Genuine native demo stores from a private copy of this isolated synthetic seed. This is
  // independent of the SPA smoke stores and cannot enable the production S53b vault lifecycle.
  const nativeSeed = spawnSync(
    process.execPath,
    [
      "--import",
      join(REPO, "tools", "node-ts", "resolveTs.ts"),
      join(REPO, "apps", "host", "src", "testing", "seedOverviewDemo.ts"),
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (nativeSeed.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`native demo genesis failed: ${nativeSeed.stderr}`);
  }
  // Genesis has folded the synthetic Python fixture into native stores. The target's copied
  // database must not trigger legacy-data admission on Electron launch; the source stays intact.
  for (const name of ["cashu.db", "cashu.db-wal", "cashu.db-shm", "cashu.db-journal"])
    rmSync(join(process.env.E2E_NATIVE_DATA_DIR, name), { force: true });
  // The exact oracle belongs to this post-genesis state. Specs that edit native stores may
  // precede Overview under Playwright's filename ordering, so keep a private temp snapshot.
  process.env.E2E_NATIVE_BASELINE_DIR = join(root, "native-baseline");
  cpSync(process.env.E2E_NATIVE_DATA_DIR, process.env.E2E_NATIVE_BASELINE_DIR, {
    recursive: true,
  });
  process.env.E2E_APP_DIR = APP_DIR;
  process.env.E2E_REPO = REPO;
  process.env.E2E_ELECTRON = require("electron") as string;

  // A trusted, empty app-protocol page for tests that inject their own single store-port client.
  // The production renderer already owns one relay per frame and must never share that port.
  const storePage = join(APP_DIR, "dist", "renderer", "e2e-store.html");
  const storeScript = join(APP_DIR, "dist", "renderer", "e2e-store.js");
  rmSync(storePage, { force: true });
  rmSync(storeScript, { force: true });
  writeFileSync(storeScript, await storeHarnessScript(), { mode: 0o600, flag: "wx" });
  writeFileSync(
    storePage,
    '<!doctype html><html><body><main><h1>Native store test</h1></main><script src="./e2e-store.js"></script></body></html>',
    {
      mode: 0o600,
      flag: "wx",
    },
  );

  return async () => {
    rmSync(storePage, { force: true });
    rmSync(storeScript, { force: true });
    if (process.env.E2E_KEEP === "1") process.stderr.write(`kept ${root}\n`);
    else rmSync(root, { recursive: true, force: true });
  };
}
