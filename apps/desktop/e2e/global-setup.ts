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
import { DEMO_EXPECTATIONS_FILE, warsawToday } from "./demo-expectations.ts";
import { storeHarnessScript } from "./electron-test.ts";
import { APP_DIR, REPO } from "./prepare-specs.ts";

const require = createRequire(import.meta.url);

export default async function globalSetup() {
  const renderer = join(APP_DIR, "dist", "renderer", "index.html");
  const main = join(APP_DIR, "dist", "main.js");
  if (!existsSync(renderer))
    throw new Error(`No native renderer at ${renderer}: build @cashu/desktop first.`);
  if (!existsSync(main))
    throw new Error(`No build at ${main}: run \`pnpm --filter @cashu/desktop build\` first.`);

  const tempRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const root = realpathSync(mkdtempSync(join(tempRoot, "cashu-e2e-desktop-")));
  // Drop pre-rename environment variables: the CLI still reads FINANSE_* as a fallback.
  for (const key of Object.keys(process.env))
    if (key.startsWith("FINANSE_")) delete process.env[key];
  mkdirSync(join(root, "home"));
  const dataDir = join(root, "native-data");
  Object.assign(process.env, {
    CASHU_TESTING: "1",
    HOME: join(root, "home"),
    CASHU_DATA_DIR: join(root, "data"),
    CASHU_WORKSPACES_DIR: join(root, "workspaces"),
    TMPDIR: tempRoot,
    // The shell runs on Warsaw time (electron-test.ts launchEnv); the seed and its day must too.
    TZ: "Europe/Warsaw",
    E2E_ROOT: root,
    E2E_NATIVE_DATA_DIR: dataDir,
    E2E_TODAY: warsawToday(),
    E2E_DEMO_EXPECTATIONS: join(root, DEMO_EXPECTATIONS_FILE),
  });

  // The synthetic native demo (apps/host/src/testing/devDemo.ts) beside the moduleless bootstrap
  // vault, and the frozen expectations the TS store computes for it. No Python, no OS keychain.
  const seed = spawnSync(
    process.execPath,
    [
      "--import",
      join(REPO, "tools", "node-ts", "resolveTs.ts"),
      join(REPO, "apps", "host", "src", "testing", "seedOverviewDemo.ts"),
    ],
    { env: process.env, encoding: "utf8" },
  );
  if (seed.status !== 0 || !existsSync(join(root, DEMO_EXPECTATIONS_FILE))) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`synthetic native demo failed: ${seed.stderr}`);
  }
  // Every spec that serves the native demo restores this snapshot first (native-baseline.ts).
  process.env.E2E_NATIVE_BASELINE_DIR = join(root, "native-baseline");
  cpSync(dataDir, process.env.E2E_NATIVE_BASELINE_DIR, { recursive: true });
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
