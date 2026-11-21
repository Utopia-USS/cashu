// Real-dir refusal for the Node hosts that read a Python data dir and write next to it
// (`cashu-next genesis`, S26 spec 9.4 / 6.1; the sync daemon, S31a spec 2.3). Checked on resolved
// paths before anything is read: the owner's real data dir, workspaces and installed app are never a
// source or a target, and the outputs never land inside the data dir or a git work tree. Comparisons
// ignore case (macOS and Windows file systems do) so `cashu` and `CASHU` cannot slip past.
//
// The real locations: on every platform the agent workspaces under the home and macOS's
// `~/Library/Application Support/cashu*` and `/Applications/<flavor>.app`; on Windows also
// `%LOCALAPPDATA%\cashu*` (every flavor's default data dir `dataDirName(flavor, "win32")`, and the
// updater cache beside it) and the per-user install dir `%LOCALAPPDATA%\Programs\cashu`. The Windows
// rules use Windows path semantics whatever OS runs them (tests inject the platform).
import { existsSync, realpathSync } from "node:fs";
import * as nodePath from "node:path";
import { basename, dirname, join, win32 } from "node:path";
import {
  appBundleName,
  FLAVOR_IDS,
  FLAVORS,
  legacyWorkspacesRoot,
  workspacesRoot,
} from "./flavor.js";
import { winIsAbsolute } from "./windowsPath.js";

const FLAVOR_LIST = FLAVOR_IDS.map((id) => FLAVORS[id]);

/** A refused invocation (exit 64). The message names flags or config keys, never data. */
export class RefusalError extends Error {
  readonly exitCode = 64;

  constructor(message: string) {
    super(message);
    this.name = "RefusalError";
  }
}

/**
 * The real path of `path` (absolute): symlinks resolved on the longest existing prefix, the rest
 * appended, so a target that does not exist yet (`--out`, a new keys file) resolves too. `platform`
 * is the OS whose file system this process sees (never an injected one: the disk is the real one).
 */
export function resolveReal(path: string, platform: NodeJS.Platform = process.platform): string {
  const tail: string[] = [];
  let head = path;
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  return join(existingRealPath(head, platform), ...tail);
}

/**
 * The real path of an existing `path` (throws when it does not exist). Windows uses the native
 * realpath: the letter case stored on disk and long names instead of 8.3 short ones, the form the
 * keyring's private-dir checks and the bundle identity compare, so every process derives one data dir
 * id (`hostRunPaths`) and one vault keychain service from any spelling of the same directory. macOS
 * and Linux keep the JS realpath (the given letter case). `platform` as in `resolveReal`.
 */
export const existingRealPath = (path: string, platform: NodeJS.Platform = process.platform) =>
  platform === "win32" ? realpathSync.native(path) : realpathSync(path);

type PathFlavor = Pick<typeof nodePath, "relative" | "sep" | "isAbsolute">;

const fold = (p: string) => p.toLowerCase();

/**
 * The first path component of `child` below `parent` (case-insensitive), undefined if not inside.
 * `paths` is the path flavor of both (this platform's by default); a relative result that is itself
 * absolute (Windows: another drive) is outside.
 */
function componentBelow(
  child: string,
  parent: string,
  paths: PathFlavor = nodePath,
): string | undefined {
  const rel = paths.relative(fold(parent), fold(child));
  if (rel === "") return "";
  if (rel.startsWith("..") || rel.startsWith(paths.sep) || paths.isAbsolute(rel)) return undefined;
  return rel.split(paths.sep)[0];
}

const isWithin = (child: string, parent: string, paths: PathFlavor = nodePath) =>
  componentBelow(child, parent, paths) !== undefined;

/** A path with the name the user knows it by (a CLI flag or a config key), used in messages. */
export interface GuardedPath {
  readonly label: string;
  readonly path: string;
}

/**
 * The Python data dir a host reads, and every path it writes (outputs, state, remotes, keys). All
 * paths are resolved (`resolveReal`).
 */
export interface GuardedPaths {
  readonly dataDir: GuardedPath;
  readonly outputs: readonly GuardedPath[];
}

/** The platform facts the guard reads; each defaults to this process's. Tests inject them. */
export interface GuardEnv {
  readonly platform?: NodeJS.Platform;
  /** Windows `%LOCALAPPDATA%` (default `process.env.LOCALAPPDATA`). */
  readonly localAppData?: string | undefined;
}

/**
 * The folder of electron-builder's per-user NSIS install, `%LOCALAPPDATA%\Programs\<package name>`,
 * relative to `%LOCALAPPDATA%`: the Windows build's package name is `cashu` (WINDOWS_PACKAGE_NAME in
 * apps/desktop/build/flavor-config.cjs; only the prod flavor is packaged for Windows).
 */
const WINDOWS_INSTALL_DIR = ["Programs", "cashu"] as const;

/**
 * Every spelling of `%LOCALAPPDATA%` a real Windows data dir may sit in: the variable when it is
 * absolute and `<home>\AppData\Local` (the CLI's fallback), each also as its native realpath when it
 * exists (on-disk case, long names: the canonical form `resolveReal` gives the guarded paths).
 */
function windowsLocalAppData(home: string, env: GuardEnv): string[] {
  const local = env.localAppData?.trim() ?? "";
  const roots = [
    win32.join(home, "AppData", "Local"),
    ...(winIsAbsolute(local) ? [win32.normalize(local)] : []),
  ];
  const spellings = roots.flatMap((root) => {
    try {
      return [root, realpathSync.native(root)];
    } catch {
      return [root];
    }
  });
  return [...new Set(spellings)];
}

/**
 * `path` as given and, when this process runs on Windows, in its canonical form (`resolveReal`: the
 * native realpath of its longest existing prefix), so an 8.3 short name or a junction cannot slip past
 * a caller that passed the path unresolved.
 */
function windowsSpellings(path: string): string[] {
  if (process.platform !== "win32") return [path];
  try {
    return [...new Set([path, resolveReal(path)])];
  } catch {
    return [path];
  }
}

/** The Windows rules of `refuseRealLocations` (see the header); descendants are refused too. */
function refuseWindowsRealLocations(
  { label, path }: GuardedPath,
  isDataDir: boolean,
  home: string,
  env: GuardEnv,
): void {
  const roots = windowsLocalAppData(home, env);
  for (const spelling of windowsSpellings(path)) {
    for (const local of roots) {
      const below = componentBelow(spelling, local, win32);
      if (below?.startsWith("cashu") && !(isDataDir && below === "cashu-demo")) {
        throw new RefusalError(`${label} points into the cashU application data`);
      }
      if (isWithin(spelling, win32.join(local, ...WINDOWS_INSTALL_DIR), win32)) {
        throw new RefusalError(`${label} points into the installed cashU app`);
      }
    }
  }
}

/** Refuses a path inside the owner's cashU locations (`cashU-demo` is a valid data dir only). */
function refuseRealLocations(
  guarded: GuardedPath,
  isDataDir: boolean,
  home: string,
  env: GuardEnv,
): void {
  if ((env.platform ?? process.platform) === "win32") {
    refuseWindowsRealLocations(guarded, isDataDir, home, env);
  }
  const { label, path } = guarded;
  const homes = [home, resolveReal(home)];
  for (const h of homes) {
    const appSupport = join(h, "Library", "Application Support");
    const below = componentBelow(path, appSupport);
    if (below?.startsWith("cashu") && !(isDataDir && below === "cashu-demo")) {
      throw new RefusalError(`${label} points into the cashU application data`);
    }
    if (
      FLAVOR_LIST.some(
        (flavor) =>
          isWithin(path, workspacesRoot(flavor, h)) ||
          isWithin(path, legacyWorkspacesRoot(flavor, h)),
      )
    ) {
      throw new RefusalError(`${label} points into the cashU workspaces`);
    }
  }
  if (FLAVOR_LIST.some((flavor) => isWithin(path, join("/Applications", appBundleName(flavor))))) {
    throw new RefusalError(`${label} points into the installed cashU app`);
  }
}

/** The work tree root of a git repository holding `path` (a `.git` entry on an ancestor). */
function gitWorkTree(path: string): string | undefined {
  let dir = path;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Throws `RefusalError` for paths a host must not touch: any of them in the owner's real cashU
 * locations, an output inside the data dir (or the data dir inside an output), an output or the data
 * dir inside a git work tree. `home` is the user's home directory (a fake one in tests), `env` the
 * platform facts (this process's by default).
 */
export function refusePaths(paths: GuardedPaths, home: string, env: GuardEnv = {}): void {
  const facts: GuardEnv = { localAppData: process.env.LOCALAPPDATA, ...env };
  refuseRealLocations(paths.dataDir, true, home, facts);
  for (const output of paths.outputs) refuseRealLocations(output, false, home, facts);
  const dataDir = paths.dataDir.path;
  for (const { label, path } of paths.outputs) {
    if (isWithin(path, dataDir)) throw new RefusalError(`${label} is inside the data dir`);
    if (isWithin(dataDir, path)) throw new RefusalError(`the data dir is inside ${label}`);
    if (gitWorkTree(path) !== undefined)
      throw new RefusalError(`${label} is inside a git work tree`);
  }
  if (gitWorkTree(dataDir) !== undefined) {
    throw new RefusalError(
      `${paths.dataDir.label} is inside a git work tree (a checkout's legacy data/)`,
    );
  }
}
