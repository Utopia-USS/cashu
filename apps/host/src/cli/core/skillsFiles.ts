// Filesystem behavior of desktop.cli._same_tree/_skill_dirs. Source skills are always read-only.
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
import { dirname, isAbsolute, join } from "node:path";
import { budget } from "@cashu/domain";

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
/** undefined means a recursive symlink cycle: preserve Python's error through pre-write delegation. */
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
export function pathSpelling(path: string): string {
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
export function expandHome(path: string, home: string): string {
  const plain = pathSpelling(path);
  if (plain !== "~" && !plain.startsWith("~/")) return plain;
  return pathSpelling(home.replace(/\/+$/, "") + plain.slice(1) || "/");
}
/** Keep .. for mkdir: pathlib does not remove it, and symlink/.. follows the filesystem. */
export function filesystemPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : `${cwd}/${path}`;
}
/** Resolve existing links without creating missing components before a possible delegation. */
export function directoryTarget(absolute: string): string | undefined {
  let current = "/";
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    const entry = stat(next);
    if (entry === undefined) {
      if (isSymlink(next)) return undefined;
      writableAncestor(current);
      current = next;
    } else if (!entry.isDirectory()) return undefined;
    else current = realpathSync(next);
  }
  return current;
}
/** copytree follows links; exceptional/cyclic sources must fail in legacy before native I/O. */
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
/** Access checks are only preflight. A later filesystem race never triggers a Python retry. */
export function writableAncestor(path: string): void {
  let current = path;
  while (stat(current) === undefined) current = dirname(current);
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
