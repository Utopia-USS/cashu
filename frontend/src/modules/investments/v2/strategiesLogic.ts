// Pure helpers of the Strategie tab (Strategies.tsx, docs/agents/strategies.md): the file tree rows, the default
// selection, a file's absolute path for "copy path" and the YAML issue lines.
import type { StrategyDoc, StrategyDocFile } from "../api";

export const MAIN_ID = "_main";

export type TreeRow =
  | { kind: "dir"; name: string; depth: number; key: string }
  | { kind: "file"; name: string; depth: number; key: string; path: string; fileKind: StrategyDocFile["kind"] };

/** Files as tree rows: a folder row before its first file, files indented by their depth. The server sorts by
 *  name per level; here the strategy's main document goes first. */
export function treeRows(doc: StrategyDoc): TreeRow[] {
  const files = [...doc.files].sort((a, b) =>
    Number(b.path === doc.main_file) - Number(a.path === doc.main_file)
    || a.path.split("/").length - b.path.split("/").length
    || a.path.localeCompare(b.path));
  const rows: TreeRow[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    for (let d = 0; d < parts.length - 1; d++) {
      const dir = parts.slice(0, d + 1).join("/");
      if (!seen.has(dir)) { seen.add(dir); rows.push({ kind: "dir", name: parts[d], depth: d, key: `d:${dir}` }); }
    }
    rows.push({ kind: "file", name: parts[parts.length - 1], depth: parts.length - 1, key: `f:${f.path}`, path: f.path, fileKind: f.kind });
  }
  return rows;
}

export interface Selection { id: string; path: string | null }

/** The kept selection while it still exists, else the first strategy with a document, else the first one. */
export function pickSelection(list: StrategyDoc[], current: Selection | null): Selection | null {
  if (current) {
    const doc = list.find((d) => d.id === current.id);
    if (doc && (current.path == null || doc.files.some((f) => f.path === current.path))) return current;
    if (doc) return { id: doc.id, path: doc.main_file ?? doc.files[0]?.path ?? null };
  }
  const first = list.find((d) => d.files.length > 0) ?? list[0];
  return first ? { id: first.id, path: first.main_file ?? first.files[0]?.path ?? null } : null;
}

/** Absolute path of a strategy file, for "copy path" (opening it in an editor). */
export function absolutePath(doc: StrategyDoc, path: string): string {
  const sep = doc.root.includes("\\") && !doc.root.includes("/") ? "\\" : "/";
  return doc.root + sep + path.split("/").join(sep);
}

/** 1-based lines of a YAML file that carry an issue, with the issue texts (the executed strategy.yaml only). */
export function issuesByLine<T extends { line: number | null }>(issues: T[]): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const i of issues) if (i.line) out.set(i.line, [...(out.get(i.line) ?? []), i]);
  return out;
}
