import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { SkillSource } from "@cashu/domain/core";

const IGNORED = new Set(["__pycache__", ".DS_Store"]);
const ignored = (name: string): boolean =>
  IGNORED.has(name) || name.endsWith(".pyc") || name.endsWith(".pyo");

/** Source tree_hash: ordered relative UTF-8 name, NUL, SHA256(file bytes), first 12 hex. */
export function treeHash(root: string): string {
  const digest = createHash("sha256");
  const walk = (folder: string): void => {
    const directories: string[] = [];
    for (const name of readdirSync(folder).sort()) {
      if (ignored(name)) continue;
      const path = join(folder, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error("unsafe_skill_source");
      if (stat.isDirectory()) {
        directories.push(path);
        continue;
      }
      digest.update(Buffer.from(relative(root, path).split(sep).join("/"), "utf8"));
      digest.update(Buffer.from([0]));
      digest.update(createHash("sha256").update(readFileSync(path)).digest());
    }
    for (const directory of directories) walk(directory);
  };
  walk(root);
  return digest.digest("hex").slice(0, 12);
}

/** No YAML dependency or generated asset text: read the authoritative shipped frontmatter. */
export function readSkillSource(root: string, name: string): SkillSource | null {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;
  let body: string;
  try {
    body = readFileSync(join(root, name, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  if (!body.startsWith("---\n")) return null;
  const close = body.indexOf("\n---", 4);
  if (close < 0) return null;
  const head = body.slice(4, close);
  const normalized = head.split(/\s+/).join(" ");
  const scope =
    /Applicability - POSITIVE:\s*(.*?)\s*Applicability - NEGATIVE:\s*(.*?)(?:\s*Triggers:|$)/.exec(
      normalized,
    );
  return {
    name,
    version: treeHash(join(root, name)),
    positive: scope?.[1] ?? "",
    negative: scope?.[2] ?? "",
  };
}
