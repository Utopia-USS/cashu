/// <reference types="node" />
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The name shown in the window title and the tray (core/paths.py `APP_NAME`). */
export const TITLE = "cashU";
/** Mirrors desktop/shell.py: the investments workspace is laid out for 1440 px. */
export const DEFAULT_SIZE = { width: 1480, height: 940 } as const;
export const MIN_SIZE = { width: 1024, height: 680 } as const;
export const SCREEN_MARGIN = 80;
export const STARTUP_TIMEOUT_MS = 60_000;
export const STOP_TIMEOUT_MS = 10_000;
/** The private state file next to the database (same name as the pywebview shell). */
export const STATE_FILE = "desktop.json";
/** The log of this shell (the sidecar's own output goes here, token redacted). */
export const LOG_FILE = "electron.log";
/** Subdirectory of the data dir that holds Electron's profile (cookies, cache, single-instance lock). */
export const USER_DATA_SUBDIR = "desktop-electron";
/** Subdirectory of the data dir that holds the TS store (device database, vault databases). */
export const STORE_SUBDIR = "store";
/** The bundled store process entry next to main.js (scripts/build-store.mjs). */
export const STORE_PROCESS_ENTRY = "store-process.mjs";

/** Environment variables of the shell (everything else is the sidecar's own CASHU_* contract). */
export const ENV = {
  dataDir: "CASHU_DATA_DIR",
  /** Test / dev override: the executable that serves the dashboard (default `.venv/bin/cashu`). */
  sidecarBin: "CASHU_DESKTOP_SIDECAR_BIN",
  /** JSON array of arguments placed before `--port <n>` (default `["serve"]`). */
  sidecarArgs: "CASHU_DESKTOP_SIDECAR_ARGS",
  /** The data dir must be inside this folder or the shell refuses to start (lab guard). */
  allowedRoot: "CASHU_DESKTOP_ALLOWED_DATA_ROOT",
  /** `1`: register the `cashu://` handler system-wide, packaged app only (never in dev). */
  registerProtocol: "CASHU_DESKTOP_REGISTER_PROTOCOL",
  /** `1`: closing the window hides it instead of quitting (tray keeps the app alive). */
  closeToTray: "CASHU_DESKTOP_CLOSE_TO_TRAY",
  /** `1`: skip the sidecar data dir cross-check (never in the lab). */
  skipDataDirCheck: "CASHU_DESKTOP_SKIP_DATADIR_CHECK",
  /** `1`: no tray icon (headless test runs). */
  noTray: "CASHU_DESKTOP_NO_TRAY",
  /** Pin the UI language (`pl` / `en`); default: the OS locale. */
  lang: "CASHU_LANG",
  /**
   * `1`: also start the TS store process (utility process) on a synthetic demo vault in
   * `<data dir>/store`, and hand the window a store port when it asks. TRANSITIONAL(S55a):
   * the dev flag goes when the first TS screen reads the store.
   */
  store: "CASHU_DESKTOP_STORE",
} as const;

/** The repo checkout this dev shell runs from (apps/desktop/{src,dist} -> repo root). */
export function repoRoot(moduleDir: string): string {
  return resolve(moduleDir, "..", "..", "..");
}

/** core/paths.py `default_data_dir()`: the per-user data dir when CASHU_DATA_DIR is not set. */
export function defaultDataDir(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "cashU");
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "cashU");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "cashu");
}

/**
 * `Path.resolve()` of core/paths.py: absolute, symlinks resolved as far as the path exists (macOS
 * temp dirs live behind /var -> /private/var, and the sidecar reports the resolved form).
 */
export function realResolve(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.push(current.slice(parent.length).replace(/^[\\/]+/, ""));
      current = parent;
    }
  }
}

export interface DataDirChoice {
  dir: string;
  /** True when CASHU_DATA_DIR named it (false: the platform default). */
  explicit: boolean;
}

export function resolveDataDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): DataDirChoice {
  const raw = (env[ENV.dataDir] ?? "").trim();
  if (raw) {
    const expanded = raw === "~" || raw.startsWith("~/") ? join(home, raw.slice(1)) : raw;
    return { dir: realResolve(expanded), explicit: true };
  }
  return { dir: defaultDataDir(platform, home, env), explicit: false };
}

function inside(root: string, dir: string): boolean {
  const rel = relative(realResolve(root), realResolve(dir));
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * The guard in front of the sidecar launch. A dev run (not packaged) never falls back to the
 * platform default data dir, which is where the owner's real data lives: CASHU_DATA_DIR must name
 * one. `allowedRoot` (the lab guard) additionally pins the data dir into one folder.
 * Returns an error message, or null when the data dir is acceptable.
 */
export function checkDataDir(opts: {
  choice: DataDirChoice;
  isPackaged: boolean;
  allowedRoot?: string | undefined;
}): string | null {
  const { choice, isPackaged, allowedRoot } = opts;
  if (!isPackaged && !choice.explicit) {
    return `Refusing to start a development shell on the default data dir (${choice.dir}): set ${ENV.dataDir}.`;
  }
  if (allowedRoot && !inside(allowedRoot, choice.dir)) {
    return `Refusing to start: the data dir ${choice.dir} is outside ${ENV.allowedRoot} (${allowedRoot}).`;
  }
  return null;
}
