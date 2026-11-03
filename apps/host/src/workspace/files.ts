import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pyCasefold } from "@cashu/domain";

export interface CheckedPathPolicy {
  readonly home: string;
  readonly protectedRoots: readonly string[];
  readonly checkout?: string;
  /** Complete configured target inventory from host local authority, keyed by canonical vault. */
  readonly claims: ReadonlyMap<string, string>;
}

export class WorkspacePathError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const key = (value: string): string =>
  pyCasefold(resolve(value).normalize("NFC")).replace(/[\\/]+$/, "");
const inside = (path: string, root: string): boolean =>
  key(path) === key(root) || key(path).startsWith(`${key(root)}${sep}`);
const overlap = (a: string, b: string): boolean => inside(a, b) || inside(b, a);

function existingAncestor(path: string): { spelled: string; resolved: string } {
  let cursor = path;
  for (;;) {
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new WorkspacePathError("path_symlink");
      if (!stat.isDirectory() && cursor !== path) throw new WorkspacePathError("path_is_file");
      return { spelled: cursor, resolved: realpathSync.native(cursor) };
    } catch (error) {
      if (error instanceof WorkspacePathError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new WorkspacePathError("invalid_path");
      cursor = parent;
    }
  }
}

/** Refuses every symlink component, including a dangling final link. */
function noSymlinkComponents(path: string): void {
  let cursor = parse(path).root;
  for (const part of path.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new WorkspacePathError("path_symlink");
      if (!stat.isDirectory() && cursor !== path) throw new WorkspacePathError("path_is_file");
    } catch (error) {
      if (error instanceof WorkspacePathError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function checkWorkspacePath(raw: string, vault: string, policy: CheckedPathPolicy): string {
  const value = raw.trim();
  if (!value || value.includes("\0")) throw new WorkspacePathError("path_required");
  if (!isAbsolute(value)) throw new WorkspacePathError("path_relative");
  const path = resolve(value);
  noSymlinkComponents(path);
  const ancestor = existingAncestor(path);
  const resolved = resolve(ancestor.resolved, relative(ancestor.spelled, path));
  try {
    if (!lstatSync(path).isDirectory()) throw new WorkspacePathError("path_is_file");
  } catch (error) {
    if (error instanceof WorkspacePathError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (key(resolved) === key(policy.home) || resolved === parse(resolved).root)
    throw new WorkspacePathError("path_home");
  if (
    resolved
      .slice(parse(resolved).root.length)
      .split(sep)
      .some((part) => part.startsWith("."))
  )
    throw new WorkspacePathError("path_hidden");
  if (policy.protectedRoots.some((root) => overlap(resolved, root)))
    throw new WorkspacePathError("path_data_dir");
  if (policy.checkout && inside(resolved, policy.checkout))
    throw new WorkspacePathError("path_checkout");
  for (const [other, claim] of policy.claims)
    if (other !== vault && overlap(resolved, claim))
      throw new WorkspacePathError("workspace_taken");
  return resolved;
}

export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}
export function directoryIdentity(path: string): FileIdentity {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkspacePathError("path_replaced");
  return { dev: stat.dev, ino: stat.ino };
}
function assertDirectoryIdentity(path: string, identity: FileIdentity): void {
  const current = directoryIdentity(path);
  if (current.dev !== identity.dev || current.ino !== identity.ino)
    throw new WorkspacePathError("path_replaced");
  noSymlinkComponents(path);
}

/** Publication primitive for managed files. Existing hardlinks and symlinks are refused. */
export function publishManagedText(
  root: string,
  relative: string,
  content: string,
  identity: FileIdentity,
  mode = 0o644,
): void {
  if (
    !relative ||
    isAbsolute(relative) ||
    relative.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  )
    throw new WorkspacePathError("invalid_path");
  assertDirectoryIdentity(root, identity);
  const target = join(root, relative);
  const parent = dirname(target);
  noSymlinkComponents(parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  noSymlinkComponents(parent);
  try {
    const old = lstatSync(target);
    if (!old.isFile() || old.nlink !== 1) throw new WorkspacePathError("path_replaced");
  } catch (error) {
    if (error instanceof WorkspacePathError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = join(parent, `.${relative.split(/[\\/]/).at(-1)}.tmp-${randomUUID()}`);
  try {
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      writeFileSync(fd, content, "utf8");
    } finally {
      closeSync(fd);
    }
    assertDirectoryIdentity(root, identity);
    noSymlinkComponents(parent);
    try {
      const old = lstatSync(target);
      if (!old.isFile() || old.nlink !== 1) throw new WorkspacePathError("path_replaced");
    } catch (error) {
      if (error instanceof WorkspacePathError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    renameSync(temporary, target);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* The rename consumed it or cleanup could not proceed. */
    }
  }
}
