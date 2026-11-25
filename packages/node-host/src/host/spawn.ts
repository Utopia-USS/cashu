// Starting a host on demand (dev, lab, the installed app before the login service exists): a
// detached child in its own session (setsid; on Windows its own process group, with no console
// window), stdin closed, stdout / stderr appended to the data dir's logs/host.log. Never inherit the
// parent's stdio: a host holding Claude Code's MCP pipes would corrupt the protocol and die with the
// session.
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDir } from "./paths.js";

export interface SpawnHostOptions {
  /** The executable (the host bundle's runtime: Node, or Electron with ELECTRON_RUN_AS_NODE). */
  readonly command: string;
  readonly args: readonly string[];
  /** `HostRunPaths.logPath`. */
  readonly logPath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

/** Spawns the host detached and lets it go; the child handle is returned for status and tests. */
export function spawnDetachedHost(options: SpawnHostOptions): ChildProcess {
  ensurePrivateDir(dirname(options.logPath));
  const log = openSync(options.logPath, "a", 0o600);
  try {
    const child = spawn(options.command, [...options.args], {
      detached: true,
      // Windows gives a detached child its own console window; the host is a background process.
      windowsHide: true,
      stdio: ["ignore", log, log],
      env: options.env ?? process.env,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}
