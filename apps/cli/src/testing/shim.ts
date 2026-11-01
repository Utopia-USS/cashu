// Runs the real `cashu` shim as a process (Node type stripping, as the launcher does) against temp data
// dirs, and stops every host those runs started (tests only).
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const SHIM = join(REPO, "apps/cli/src/index.ts");
const RESOLVE_TS = join(REPO, "tools/node-ts/resolveTs.ts");
export const FAKE_PYTHON = join(REPO, "apps/host/test-fixtures/fake-python-cli.mjs");
export const NODE_ARGS = [
  "--no-warnings",
  "--experimental-strip-types",
  "--import",
  RESOLVE_TS,
  SHIM,
];

export interface ShimRun {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

const hostDirs = new Set<string>();

export function spawnShim(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): ChildProcess {
  if (env.CASHU_DATA_DIR !== undefined) hostDirs.add(env.CASHU_DATA_DIR);
  return spawn(process.execPath, [...NODE_ARGS, ...args], { env, cwd, stdio: "pipe" });
}

export function runShim(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { cwd: string; input?: string },
): Promise<ShimRun> {
  const child = spawnShim(args, env, options.cwd);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (d: string) => {
    stdout += d;
  });
  child.stderr?.setEncoding("utf8").on("data", (d: string) => {
    stderr += d;
  });
  child.stdin?.end(options.input ?? "");
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/** The pid of the data dir's running host, if any. */
export function hostPid(dataDir: string): number | undefined {
  try {
    return JSON.parse(readFileSync(join(dataDir, "run", "host.json"), "utf8")).pid;
  } catch {
    return undefined;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kills every host a test's shims started (SIGTERM: a clean stop). */
export async function stopHosts(): Promise<void> {
  const pids = [...hostDirs].map(hostPid).filter((p): p is number => p !== undefined && alive(p));
  hostDirs.clear();
  for (const pid of pids) process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 20));
}
