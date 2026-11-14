// Test helpers for the local host: temp data dirs (never a real location), the fixture host spawned
// with Node type stripping, and process bookkeeping so no test leaves a host running.
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReal } from "../guard.js";
import { hostRunPaths } from "../host/paths.js";
import { spawnDetachedHost } from "../host/spawn.js";

const FIXTURE = fileURLToPath(new URL("./fixtureHost.ts", import.meta.url));
const RESOLVE_TS = fileURLToPath(
  new URL("../../../../tools/node-ts/resolveTs.ts", import.meta.url),
);

/** A fresh temp directory (resolved), removed by `cleanup`. */
export function tempDir(prefix = "cashu-host-"): string {
  return resolveReal(mkdtempSync(join(tmpdir(), prefix)));
}

export interface SpawnedHost {
  readonly child: ChildProcess;
  readonly exit: Promise<number | null>;
}

const children = new Set<ChildProcess>();
const dirs = new Set<string>();

export function trackDir(dir: string): string {
  dirs.add(dir);
  return dir;
}

/** Spawns the fixture host for `dataDir` the way a client would (detached, log file). */
export function spawnFixtureHost(dataDir: string, extraArgs: readonly string[] = []): SpawnedHost {
  const child = spawnDetachedHost({
    command: process.execPath,
    args: [
      "--disable-warning=ExperimentalWarning",
      "--experimental-strip-types",
      "--import",
      RESOLVE_TS,
      FIXTURE,
      dataDir,
      ...extraArgs,
    ],
    logPath: hostRunPaths(dataDir).logPath,
  });
  children.add(child);
  const exit = new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
  return { child, exit };
}

export const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Kills every spawned host still running and removes the temp dirs. */
export function cleanup(): void {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
}
