// Refusals of `cashu-next genesis` (S26 spec 9.4, 6.1): checked on resolved paths before anything is
// read. The owner's real data dir, workspaces and installed app are never a source or a target, and
// the plaintext outputs never land inside the data dir or a git work tree. Comparisons ignore case
// (macOS file systems do) so `cashu` and `CASHU` cannot slip past.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

/** A refused invocation (exit 64). The message names flags, never data. */
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

type Flag = "--data-dir" | "--out" | "--keys";

/** Refuses a path inside the owner's cashU locations (`cashU-demo` is a valid `--data-dir`). */
function refuseRealLocations(flag: Flag, path: string, home: string): void {
  const homes = [home, resolveReal(home)];
  for (const h of homes) {
    const appSupport = join(h, "Library", "Application Support");
    const below = componentBelow(path, appSupport);
    if (below?.startsWith("cashu") && !(flag === "--data-dir" && below === "cashu-demo")) {
      throw new RefusalError(`${flag} points into the cashU application data`);
    }
    if (isWithin(path, join(h, "Documents", "cashU"))) {
      throw new RefusalError(`${flag} points into the cashU workspaces`);
    }
  }
  if (isWithin(path, "/Applications/cashU.app")) {
    throw new RefusalError(`${flag} points into the installed cashU app`);
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

export interface GenesisPaths {
  readonly dataDir: string;
  readonly out: string;
  readonly keys: string;
}

/**
 * Throws `RefusalError` for paths genesis must not touch. `paths` are resolved (`resolveReal`);
 * `home` is the user's home directory (a fake one in tests).
 */
export function refusePaths(paths: GenesisPaths, home: string): void {
  refuseRealLocations("--data-dir", paths.dataDir, home);
  refuseRealLocations("--out", paths.out, home);
  refuseRealLocations("--keys", paths.keys, home);
  for (const [flag, path] of [
    ["--out", paths.out],
    ["--keys", paths.keys],
  ] as const) {
    if (isWithin(path, paths.dataDir)) throw new RefusalError(`${flag} is inside the data dir`);
    if (isWithin(paths.dataDir, path)) throw new RefusalError(`the data dir is inside ${flag}`);
    if (gitWorkTree(path) !== undefined)
      throw new RefusalError(`${flag} is inside a git work tree`);
  }
  if (gitWorkTree(paths.dataDir) !== undefined) {
    throw new RefusalError("--data-dir is inside a git work tree (a checkout's legacy data/)");
  }
}
