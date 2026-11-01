// The dev checkout's Python app for oracle tests (tests only). CI has no Python, so those suites are
// skipped there (describe.skipIf(!HAS_PYTHON)); locally they run against the repo's `.venv`. Every run
// gets a temp data dir, a temp HOME and CASHU_TESTING=1 (no `.env.dev`, no network fetches, the legacy
// migration refuses real paths): never the owner's data, never the lab copy.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tempDir } from "./harness.js";

const VENV = fileURLToPath(new URL("../../../../.venv/bin/", import.meta.url));
const PYTHON = `${VENV}python`;
const PYTHON_CLI = `${VENV}cashu`;
export const HAS_PYTHON = existsSync(PYTHON) && existsSync(PYTHON_CLI);

/** An isolated environment for the Python app: temp data dir and HOME, tests mode. */
function pythonEnv(dataDir = tempDir("cashu-py-data-")): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("CASHU_") || key.startsWith("FINANSE_")) delete env[key];
  return {
    ...env,
    CASHU_DATA_DIR: dataDir,
    CASHU_WORKSPACES_DIR: tempDir("cashu-py-ws-"),
    CASHU_AUTO_DAILY: "0",
    CASHU_TESTING: "1",
    HOME: tempDir("cashu-py-home-"),
  };
}

/** Runs Python code; returns stdout (throws with stderr on a non-zero exit). */
export function python(code: string, env: NodeJS.ProcessEnv = pythonEnv()): string {
  const r = spawnSync(PYTHON, ["-c", code], { env, encoding: "utf8", timeout: 60_000 });
  if (r.status !== 0) throw new Error(`python failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}
