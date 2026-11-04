import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { WorkspacePublication } from "./adapter.js";
import { directoryIdentity, publishManagedText, WorkspacePathError } from "./files.js";

const SKILL_NAME = /^[a-z][a-z0-9-]*$/;
const MAX_SKILL_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_ENTRIES = 256;
const MAX_SKILL_DEPTH = 12;
const inside = (root: string, path: string): string | null => {
  if (!isAbsolute(path) || resolve(path) !== path) return null;
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
    ? part
    : null;
};
const kindAt = (path: string): ReturnType<WorkspacePublication["kind"]> => {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
};
function checkedAncestors(path: string): readonly { path: string; dev: number; ino: number }[] {
  let cursor = parse(path).root;
  const identities: { path: string; dev: number; ino: number }[] = [];
  for (const part of path.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const kind = kindAt(cursor);
    if (kind === "symlink" || kind === "other" || kind === "file")
      throw new WorkspacePathError("path_replaced");
    if (kind === "directory") {
      const stat = lstatSync(cursor);
      identities.push({ path: cursor, dev: stat.dev, ino: stat.ino });
    }
  }
  return identities;
}
function readCheckedBytes(path: string, maxBytes: number): Buffer | null {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_SKILL_BYTES)
    throw new WorkspacePathError("unsafe_read");
  const ancestors = checkedAncestors(dirname(path));
  if (kindAt(path) === "missing") return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes)
    throw new WorkspacePathError("unsafe_read");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino ||
      opened.uid !== stat.uid ||
      opened.size > maxBytes
    )
      throw new WorkspacePathError("path_replaced");
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > maxBytes) throw new WorkspacePathError("unsafe_read");
    const after = lstatSync(path);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.uid !== opened.uid)
      throw new WorkspacePathError("path_replaced");
    for (const ancestor of ancestors) {
      const latest = lstatSync(ancestor.path);
      if (
        !latest.isDirectory() ||
        latest.isSymbolicLink() ||
        latest.dev !== ancestor.dev ||
        latest.ino !== ancestor.ino
      )
        throw new WorkspacePathError("path_replaced");
    }
    return bytes.subarray(0, count);
  } finally {
    closeSync(fd);
  }
}
export function readCheckedText(path: string, maxBytes: number): string | null {
  if (maxBytes > 1024 * 1024) throw new WorkspacePathError("unsafe_read");
  return readCheckedBytes(path, maxBytes)?.toString("utf8") ?? null;
}
function checkedTree(path: string, size: { total: number; entries: number }, depth = 0): void {
  if (depth > MAX_SKILL_DEPTH) throw new WorkspacePathError("skill_too_large");
  if (kindAt(path) !== "directory") throw new WorkspacePathError("path_replaced");
  for (const name of readdirSync(path)) {
    if (++size.entries > MAX_SKILL_ENTRIES) throw new WorkspacePathError("skill_too_large");
    const child = join(path, name);
    const stat = lstatSync(child);
    if (stat.isDirectory() && !stat.isSymbolicLink()) checkedTree(child, size, depth + 1);
    else if (stat.isFile() && stat.nlink === 1) {
      size.total += stat.size;
      if (size.total > MAX_SKILL_BYTES) throw new WorkspacePathError("skill_too_large");
    } else throw new WorkspacePathError("path_replaced");
  }
}
export function secureTreeHash(root: string): string {
  const digest = createHash("sha256");
  const seen = { entries: 0, total: 0 };
  const walk = (folder: string, depth: number): void => {
    if (depth > MAX_SKILL_DEPTH) throw new WorkspacePathError("skill_too_large");
    const directories: string[] = [];
    for (const name of readdirSync(folder).sort()) {
      if (
        name === ".DS_Store" ||
        name === "__pycache__" ||
        name.endsWith(".pyc") ||
        name.endsWith(".pyo")
      )
        continue;
      if (++seen.entries > MAX_SKILL_ENTRIES) throw new WorkspacePathError("skill_too_large");
      const path = join(folder, name);
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) directories.push(path);
      else if (stat.isFile() && stat.nlink === 1) {
        const bytes = readCheckedBytes(path, MAX_SKILL_BYTES);
        if (!bytes) throw new WorkspacePathError("path_replaced");
        seen.total += bytes.length;
        if (seen.total > MAX_SKILL_BYTES) throw new WorkspacePathError("skill_too_large");
        digest.update(Buffer.from(relative(root, path).split(sep).join("/"), "utf8"));
        digest.update(Buffer.from([0]));
        digest.update(createHash("sha256").update(bytes).digest());
      } else throw new WorkspacePathError("path_replaced");
    }
    for (const directory of directories) walk(directory, depth + 1);
  };
  checkedTree(root, { total: 0, entries: 0 });
  walk(root, 0);
  return digest.digest("hex").slice(0, 12);
}
function copyTree(
  source: string,
  target: string,
  depth = 0,
  seen = { entries: 0, total: 0 },
): void {
  if (depth > MAX_SKILL_DEPTH) throw new WorkspacePathError("skill_too_large");
  mkdirSync(target, { mode: 0o700 });
  for (const name of readdirSync(source)) {
    if (
      name === ".DS_Store" ||
      name === "__pycache__" ||
      name.endsWith(".pyc") ||
      name.endsWith(".pyo")
    )
      continue;
    if (++seen.entries > MAX_SKILL_ENTRIES) throw new WorkspacePathError("skill_too_large");
    const from = join(source, name);
    const to = join(target, name);
    const stat = lstatSync(from);
    if (stat.isDirectory() && !stat.isSymbolicLink()) copyTree(from, to, depth + 1, seen);
    else if (stat.isFile() && stat.nlink === 1) {
      const bytes = readCheckedBytes(from, MAX_SKILL_BYTES);
      if (!bytes) throw new WorkspacePathError("path_replaced");
      seen.total += bytes.length;
      if (seen.total > MAX_SKILL_BYTES) throw new WorkspacePathError("skill_too_large");
      const fd = openSync(
        to,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
    } else throw new WorkspacePathError("path_replaced");
  }
}

/** One exact workspace and one exact private config file, with a live native-session guard. */
export function createProductionPublication(input: {
  workspace: string;
  config: string;
  skillSource: string;
  isCurrent(): boolean;
}): WorkspacePublication {
  const { workspace, config, skillSource } = input;
  let workspaceIdentity: ReturnType<typeof directoryIdentity> | null = null;
  const scope = (path: string): { root: string; part: string } => {
    if (!input.isCurrent()) throw new WorkspacePathError("stale_capability");
    const part = inside(workspace, path);
    if (part !== null) {
      checkedAncestors(dirname(path));
      if (workspaceIdentity && kindAt(workspace) === "directory") {
        const current = directoryIdentity(workspace);
        if (current.dev !== workspaceIdentity.dev || current.ino !== workspaceIdentity.ino)
          throw new WorkspacePathError("path_replaced");
      }
      return { root: workspace, part };
    }
    if (path === config) {
      checkedAncestors(dirname(config));
      return { root: dirname(config), part: config.slice(dirname(config).length + 1) };
    }
    throw new WorkspacePathError("outside_capability");
  };
  const kind = (path: string): ReturnType<WorkspacePublication["kind"]> => {
    scope(path);
    return kindAt(path);
  };
  const ensure = (path: string, mode = 0o700): void => {
    scope(path);
    if (!["missing", "directory"].includes(kindAt(path)))
      throw new WorkspacePathError("path_replaced");
    mkdirSync(path, { recursive: true, mode });
    checkedAncestors(path);
    if (kindAt(workspace) === "directory" && workspaceIdentity === null)
      workspaceIdentity = directoryIdentity(workspace);
  };
  return {
    kind,
    readText(path, maxBytes) {
      scope(path);
      const result = readCheckedText(path, maxBytes);
      scope(path);
      return result;
    },
    skillHash(path) {
      scope(path);
      if (kindAt(path) !== "directory") return null;
      return secureTreeHash(path);
    },
    readLink(path) {
      scope(path);
      return kindAt(path) === "symlink" ? readlinkSync(path) : null;
    },
    ensureDirectory: ensure,
    writeText(path, text, mode = 0o644) {
      const { root, part } = scope(path);
      if (!part || Buffer.byteLength(text) > 1024 * 1024)
        throw new WorkspacePathError("unsafe_write");
      if (path === config) {
        mkdirSync(root, { recursive: true, mode: 0o700 });
        checkedAncestors(root);
      } else ensure(root, 0o700);
      publishManagedText(root, part, text, directoryIdentity(root), mode);
    },
    backup(from, to) {
      scope(from);
      scope(to);
      if (!["file", "directory"].includes(kindAt(from)))
        throw new WorkspacePathError("path_replaced");
      if (kindAt(from) === "file" && lstatSync(from).nlink !== 1)
        throw new WorkspacePathError("path_replaced");
      if (kindAt(from) === "directory") checkedTree(from, { total: 0, entries: 0 });
      let target = to;
      for (let n = 2; kindAt(target) !== "missing"; n++) target = `${to}-${n}`;
      ensure(dirname(target));
      scope(from);
      renameSync(from, target);
    },
    copySkill(name, to) {
      scope(to);
      if (!SKILL_NAME.test(name)) throw new WorkspacePathError("invalid_skill");
      const source = join(skillSource, name);
      checkedAncestors(source);
      checkedTree(source, { total: 0, entries: 0 });
      if (kindAt(join(source, "SKILL.md")) !== "file")
        throw new WorkspacePathError("missing_skill");
      ensure(dirname(to));
      const stage = `${to}.tmp-${randomUUID()}`;
      try {
        copyTree(source, stage);
        scope(to);
        if (kindAt(to) === "directory") {
          checkedTree(to, { total: 0, entries: 0 });
          rmSync(to, { recursive: true });
        } else if (kindAt(to) !== "missing") throw new WorkspacePathError("path_replaced");
        renameSync(stage, to);
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    },
    removeSkill(path) {
      scope(path);
      checkedTree(path, { total: 0, entries: 0 });
      rmSync(path, { recursive: true });
    },
    createLink(path, target) {
      scope(path);
      if (kindAt(path) !== "missing" || !["CLAUDE.md", "../.claude/skills"].includes(target))
        throw new WorkspacePathError("path_replaced");
      ensure(dirname(path));
      symlinkSync(target, path);
    },
    removeFile(path) {
      scope(path);
      if (kindAt(path) !== "file" || lstatSync(path).nlink !== 1)
        throw new WorkspacePathError("path_replaced");
      unlinkSync(path);
    },
  };
}
