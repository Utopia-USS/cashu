/// <reference types="node" />
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_FILE } from "./config.js";

export type DesktopState = Record<string, unknown>;

export function statePath(dataDir: string): string {
  return join(dataDir, STATE_FILE);
}

/** A newly created dir is 0700 (core/paths.py `ensure_private_dir`). */
export function ensurePrivateDir(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(path, 0o700);
  }
  return path;
}

export function loadState(path: string): DesktopState {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as DesktopState)
      : {};
  } catch {
    return {};
  }
}

/** Atomic and owner-only (0600), like `shell.save_state`. */
export function saveState(path: string, state: DesktopState): void {
  ensurePrivateDir(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The port remembered for the next launch, so the window's origin (and its localStorage) stays. */
export function rememberedPort(state: DesktopState): number | null {
  const port = state.port;
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535
    ? port
    : null;
}

/** Best effort: a read-only or full disk must not keep the window from opening. */
export function rememberPort(path: string, port: number): void {
  try {
    const state = loadState(path);
    if (state.port !== port) saveState(path, { ...state, port });
  } catch {
    // ignored on purpose
  }
}
