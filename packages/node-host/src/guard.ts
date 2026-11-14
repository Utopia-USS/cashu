// Real-dir refusal for the Node hosts that read a Python data dir and write next to it
// (`cashu-next genesis`, S26 spec 9.4 / 6.1; the sync daemon, S31a spec 2.3). Checked on resolved
// paths before anything is read: the owner's real data dir, workspaces and installed app are never a
// source or a target, and the outputs never land inside the data dir or a git work tree. Comparisons
// ignore case (macOS file systems do) so `cashu` and `CASHU` cannot slip past.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  appBundleName,
  FLAVOR_IDS,
  FLAVORS,
  legacyWorkspacesRoot,
  workspacesRoot,
} from "./flavor.js";

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
 * appended, so a target that does not exist yet (`--out`, a new keys file) resolves too.
 */
export function resolveReal(path: string): string {
  const tail: string[] = [];
  let head = path;
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  return join(realpathSync(head), ...tail);
}

const fold = (p: string) => p.toLowerCase();

/** The first path component of `child` below `parent` (case-insensitive), undefined if not inside. */
function componentBelow(child: string, parent: string): string | undefined {
  const rel = relative(fold(parent), fold(child));
  if (rel === "") return "";
  if (rel.startsWith("..") || rel.startsWith(sep)) return undefined;
  return rel.split(sep)[0];
}

const isWithin = (child: string, parent: string) => componentBelow(child, parent) !== undefined;

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

/** Refuses a path inside the owner's cashU locations (`cashU-demo` is a valid data dir only). */
function refuseRealLocations({ label, path }: GuardedPath, isDataDir: boolean, home: string): void {
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
 * dir inside a git work tree. `home` is the user's home directory (a fake one in tests).
 */
export function refusePaths(paths: GuardedPaths, home: string): void {
  refuseRealLocations(paths.dataDir, true, home);
  for (const output of paths.outputs) refuseRealLocations(output, false, home);
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
