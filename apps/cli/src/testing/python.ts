// The dev checkout's Python app for oracle and parity tests (tests only). CI has no Python, so those
// suites are skipped there (describe.skipIf(!HAS_PYTHON)); locally they run against the repo's
// `.venv`. Every run gets a temp data dir, a temp HOME and CASHU_TESTING=1 (no `.env.dev`, no network
// fetches, the legacy migration refuses real paths): never the owner's data, never the lab copy.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VENV = fileURLToPath(new URL("../../../../.venv/bin/", import.meta.url));
const PYTHON = `${VENV}python`;
const PYTHON_CLI = `${VENV}cashu`;
export const HAS_PYTHON = existsSync(PYTHON) && existsSync(PYTHON_CLI);

/** The process env without any CASHU_ / FINANSE_ variable (each test sets its own). */
export function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CASHU_") || key.startsWith("FINANSE_") || key === "XDG_DATA_HOME") {
      delete env[key];
    }
  }
  return env;
}

/** Runs Python code with `env`; returns stdout (throws with stderr on a non-zero exit). */
export function python(code: string, env: NodeJS.ProcessEnv, cwd?: string): string {
  const r = spawnSync(PYTHON, ["-c", code], {
    env,
    encoding: "utf8",
    timeout: 60_000,
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (r.status !== 0) throw new Error(`python failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}
