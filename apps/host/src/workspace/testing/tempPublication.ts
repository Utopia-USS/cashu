/** Test-only publication capability for isolated synthetic roots. Never bind it to a real vault. */

import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { WorkspacePublication } from "../adapter.js";
import { directoryIdentity, publishManagedText } from "../files.js";
import { treeHash } from "../skills.js";

export function createTempPublication(
  workspace: string,
  dataRoot: string,
  skillSource: string,
): WorkspacePublication {
  const scope = (path: string): { root: string; relative: string } => {
    for (const root of [workspace, dataRoot]) {
      const rel = relative(root, path);
      if (rel && rel !== ".." && !rel.startsWith(`..${sep}`)) return { root, relative: rel };
      if (path === root) return { root, relative: "" };
    }
    throw new Error("outside_test_capability");
  };
  const kind = (path: string): "missing" | "file" | "directory" | "symlink" | "other" => {
    scope(path);
    try {
      const stat = lstatSync(path);
      return stat.isSymbolicLink()
        ? "symlink"
        : stat.isFile()
          ? "file"
          : stat.isDirectory()
            ? "directory"
            : "other";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  };
  return {
    kind,
    readText(path, maxBytes) {
      if (kind(path) === "missing") return null;
      if (kind(path) !== "file") throw new Error("unsafe_test_read");
      if (lstatSync(path).size > maxBytes) throw new Error("oversize_test_read");
      return readFileSync(path, "utf8");
    },
    skillHash(path) {
      return kind(path) === "directory" ? treeHash(path) : null;
    },
    readLink(path) {
      return kind(path) === "symlink" ? readlinkSync(path) : null;
    },
    ensureDirectory(path, mode = 0o700) {
      scope(path);
      if (kind(path) !== "missing" && kind(path) !== "directory")
        throw new Error("unsafe_test_directory");
      mkdirSync(path, { recursive: true, mode });
    },
    writeText(path, text, mode = 0o644) {
      const { root, relative: rel } = scope(path);
      if (!existsSync(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
      publishManagedText(root, rel, text, directoryIdentity(root), mode);
    },
    backup(from, to) {
      scope(from);
      scope(to);
      let dest = to;
      for (let n = 2; kind(dest) !== "missing"; n++) dest = `${to}-${n}`;
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      renameSync(from, dest);
    },
    copySkill(name, to) {
      scope(to);
      if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("unsafe_test_skill");
      const source = join(skillSource, name);
      if (!existsSync(join(source, "SKILL.md"))) throw new Error("missing_test_skill");
      mkdirSync(dirname(to), { recursive: true });
      const stage = `${to}.tmp-${randomUUID()}`;
      try {
        cpSync(source, stage, {
          recursive: true,
          filter: (path) =>
            ![".DS_Store", "__pycache__"].includes(path.split(sep).at(-1) ?? "") &&
            !path.endsWith(".pyc") &&
            !path.endsWith(".pyo"),
        });
        if (kind(to) !== "missing") rmSync(to, { recursive: true });
        renameSync(stage, to);
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    },
    removeSkill(path) {
      scope(path);
      if (kind(path) !== "directory") throw new Error("unsafe_test_skill");
      rmSync(path, { recursive: true });
    },
    createLink(path, target) {
      scope(path);
      mkdirSync(dirname(path), { recursive: true });
      if (kind(path) !== "missing") throw new Error("test_link_conflict");
      symlinkSync(target, path);
    },
    removeFile(path) {
      scope(path);
      if (kind(path) !== "file") throw new Error("unsafe_test_file");
      rmSync(path);
    },
  };
}
