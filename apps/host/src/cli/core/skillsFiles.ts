// Filesystem behavior of desktop.cli._same_tree/_skill_dirs. Source skills are always read-only.
// Path arithmetic takes the platform's path module (`hostPath`; tests inject `win32` / `posix`):
// POSIX keeps pathlib's spelling and lets `symlink/..` follow the filesystem, Windows spells with
// `\` and resolves `..` lexically, as the Win32 API itself does before the filesystem sees a path.
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join, type PlatformPath, posix, win32 } from "node:path";
import { budget } from "@cashu/domain";

/** The path module of the machine the host (and so its clients) runs on. */
export const hostPath: PlatformPath = process.platform === "win32" ? win32 : posix;
const windows = (p: PlatformPath) => p.sep === "\\";
/** Separators of one path: Windows takes both, POSIX only `/` (a `\` is part of a name there). */
const separators = (p: PlatformPath) => (windows(p) ? /[\\/]/ : "/");
/** `D:skills`: relative to that drive's own current folder, which only the caller's shell knows. */
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;

const IGNORED = new Set(["RCS", "CVS", "tags", ".git", ".hg", ".bzr", "_darcs", "__pycache__"]);
export function stat(path: string) {
  try {
    return statSync(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
function missing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
function sameFile(a: string, b: string): boolean {
  let left: number | undefined;
  let right: number | undefined;
  try {
    if (statSync(a).size !== statSync(b).size) return false;
    left = openSync(a, "r");
    right = openSync(b, "r");
    const x = Buffer.alloc(8192);
    const y = Buffer.alloc(8192);
    for (;;) {
      const nx = readSync(left, x, 0, x.length, null);
      const ny = readSync(right, y, 0, y.length, null);
      if (nx !== ny || !x.subarray(0, nx).equals(y.subarray(0, ny))) return false;
      if (nx === 0) return true;
    }
  } catch {
    return false;
  } finally {
    if (left !== undefined) closeSync(left);
    if (right !== undefined) closeSync(right);
  }
}
/** undefined means a recursive symlink cycle; refuse before any write. */
export function sameTree(a: string, b: string, ancestors = new Set<string>()): boolean | undefined {
  const sa = statSync(a);
  const sb = statSync(b);
  const pair = `${sa.dev}:${sa.ino}|${sb.dev}:${sb.ino}`;
  if (ancestors.has(pair)) return undefined;
  const next = new Set(ancestors).add(pair);
  const names = (path: string) =>
    readdirSync(path)
      .filter((name) => !IGNORED.has(name))
      .sort(budget.codePointCompare);
  const left = names(a);
  const right = names(b);
  if (left.length !== right.length || left.some((name, i) => name !== right[i])) return false;
  for (const name of left) {
    const x = join(a, name);
    const y = join(b, name);
    let sx: ReturnType<typeof stat>;
    let sy: ReturnType<typeof stat>;
    try {
      sx = stat(x);
      sy = stat(y);
    } catch {
      continue;
    }
    // Python _same_tree does not inspect dircmp.common_funny (missing/type-mismatched entries).
    if (sx === undefined || sy === undefined) continue;
    if (sx.isFile() && sy.isFile()) {
      if (!sameFile(x, y)) return false;
    } else if (sx.isDirectory() && sy.isDirectory()) {
      const same = sameTree(x, y, next);
      if (same !== true) return same;
    }
  }
  return true;
}
export function skillNames(source: string): string[] {
  return readdirSync(source)
    .filter(
      (name) =>
        stat(join(source, name))?.isDirectory() && stat(join(source, name, "SKILL.md"))?.isFile(),
    )
    .sort(budget.codePointCompare);
}
export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
/** pathlib's lexical spelling: removes empty/dot pieces but keeps .. (also in printed targets). */
export function pathSpelling(path: string, p: PlatformPath = hostPath): string {
  if (windows(p)) {
    // PureWindowsPath: the drive / UNC root with backslashes, then the pieces joined by `\`.
    const root = p.parse(path).root;
    const rest = path
      .slice(root.length)
      .split(/[\\/]/)
      .filter((part) => part !== "" && part !== ".")
      .join("\\");
    return root.replaceAll("/", "\\") + rest || ".";
  }
  const prefix =
    path.startsWith("//") && !path.startsWith("///") ? "//" : path.startsWith("/") ? "/" : "";
  return (
    prefix +
      path
        .split("/")
        .filter((part) => part !== "" && part !== ".")
        .join("/") || "."
  );
}
/** `~` or `~/...` (`~\...` on Windows) after spelling: the caller's home folder. */
export function homeRelative(spelling: string, p: PlatformPath = hostPath): boolean {
  return spelling === "~" || spelling.startsWith(`~${p.sep}`);
}
export function expandHome(path: string, home: string, p: PlatformPath = hostPath): string {
  const plain = pathSpelling(path, p);
  if (!homeRelative(plain, p)) return plain;
  const trimmed = windows(p) ? home.replace(/[\\/]+$/, "") : home.replace(/\/+$/, "");
  return pathSpelling(trimmed + plain.slice(1) || p.sep, p);
}
/**
 * The destination against the caller's cwd. POSIX keeps .. for mkdir: pathlib does not remove it,
 * and symlink/.. follows the filesystem. Windows resolves it lexically (the OS does the same). A
 * drive-relative path on another drive than the cwd is undefined: its base is not known here.
 */
export function filesystemPath(
  cwd: string,
  path: string,
  p: PlatformPath = hostPath,
): string | undefined {
  if (!windows(p)) return p.isAbsolute(path) ? path : `${cwd}/${path}`;
  if (DRIVE_RELATIVE.test(path) && path[0]?.toLowerCase() !== driveOf(cwd)) return undefined;
  return p.resolve(cwd, path);
}
/** The lower-case drive letter of `C:\...`, undefined for a UNC path. */
function driveOf(path: string): string | undefined {
  return /^[A-Za-z]:/.test(path) ? path[0]?.toLowerCase() : undefined;
}
/** `candidate` lies below `root` (never `root` itself), compared by `p`'s rules. */
export function strictlyInside(
  root: string,
  candidate: string,
  p: PlatformPath = hostPath,
): boolean {
  const rel = p.relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}
/** Resolve existing links without creating missing components before preflight completes. */
export function directoryTarget(absolute: string, p: PlatformPath = hostPath): string | undefined {
  const root = p.parse(absolute).root;
  // A missing drive or share: nothing to create a folder on.
  if (!stat(root)?.isDirectory()) return undefined;
  let current = root;
  for (const part of absolute.slice(root.length).split(separators(p))) {
    if (!part || part === ".") continue;
    if (part === "..") {
      current = p.dirname(current);
      continue;
    }
    const next = p.join(current, part);
    const entry = stat(next);
    if (entry === undefined) {
      if (isSymlink(next)) return undefined;
      writableAncestor(current, p);
      current = next;
    } else if (!entry.isDirectory()) return undefined;
    else current = realpathSync(next);
  }
  return current;
}
/** cp follows links: an exceptional or cyclic source is refused before any write. */
export function copyableTree(path: string, ancestors = new Set<string>()): boolean {
  const entry = stat(path);
  if (entry === undefined) return false;
  if (entry.isFile()) {
    accessSync(path, constants.R_OK);
    return true;
  }
  if (!entry.isDirectory()) return false;
  const identity = `${entry.dev}:${entry.ino}`;
  if (ancestors.has(identity)) return false;
  const next = new Set(ancestors).add(identity);
  return readdirSync(path).every((name) => copyableTree(join(path, name), next));
}
/** Access checks are only preflight. A later filesystem race never triggers a retry. */
export function writableAncestor(path: string, p: PlatformPath = hostPath): void {
  let current = path;
  // Stops at the root: a missing root then fails the access check below instead of looping.
  while (stat(current) === undefined && p.dirname(current) !== current)
    current = p.dirname(current);
  accessSync(current, constants.W_OK | constants.X_OK);
}
export function removableTree(path: string): void {
  if (!lstatSync(path).isDirectory()) return;
  accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
  for (const name of readdirSync(path)) removableTree(join(path, name));
}
/** Node cp omits directory timestamps. Restore both entry types after copying their children. */
export function restoreCopyTimes(source: string, target: string): void {
  if (statSync(source).isDirectory()) {
    for (const name of readdirSync(source))
      restoreCopyTimes(join(source, name), join(target, name));
  }
  const info = statSync(source);
  utimesSync(target, info.atimeMs / 1000, info.mtimeMs / 1000);
}
