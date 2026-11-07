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
/** The log of the desktop shell. */
export const LOG_FILE = "electron.log";
/** Subdirectory of the data dir that holds Electron's profile (cookies, cache, single-instance lock). */
export const USER_DATA_SUBDIR = "desktop-electron";

/** Environment variables of the desktop shell. */
export const ENV = {
  dataDir: "CASHU_DATA_DIR",
  /** The data dir must be inside this folder or the shell refuses to start (lab guard). */
  allowedRoot: "CASHU_DESKTOP_ALLOWED_DATA_ROOT",
  /** `1`: register the `cashu://` handler system-wide, packaged app only (never in dev). */
  registerProtocol: "CASHU_DESKTOP_REGISTER_PROTOCOL",
  /** `1`: closing the window hides it instead of quitting (tray keeps the app alive). */
  closeToTray: "CASHU_DESKTOP_CLOSE_TO_TRAY",
  /** `1`: no tray icon (headless test runs). */
  noTray: "CASHU_DESKTOP_NO_TRAY",
  /** Pin the UI language (`pl` / `en`); default: the OS locale. */
  lang: "CASHU_LANG",
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
 * Resolve absolute paths and existing symlinks (macOS temp dirs live behind /var -> /private/var).
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
 * The guard before desktop startup. A dev run (not packaged) never falls back to the
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

/** The window title of a sealed test build: visibly not a release. */
export const TEST_BUILD_TITLE = `${TITLE} - TEST BUILD`;

/**
 * The data dir of a sealed test build (a manifest-verified Contents/Resources/test-build.json): the
 * one its marker names, also when the updater relaunches the app without CASHU_DATA_DIR, and never
 * the default data dir. An explicit CASHU_DATA_DIR naming another dir is refused. A release (no
 * marker) keeps its choice unchanged.
 */
export function testBuildDataDir(
  choice: DataDirChoice,
  markerDataDir: string | null,
): { readonly choice: DataDirChoice } | { readonly error: string } {
  if (markerDataDir === null) return { choice };
  if (choice.explicit && realResolve(choice.dir) !== markerDataDir)
    return {
      error: `Refusing to start a TEST BUILD outside its data dir (${markerDataDir}): unset ${ENV.dataDir} or set it to that dir.`,
    };
  return { choice: { dir: markerDataDir, explicit: true } };
}
