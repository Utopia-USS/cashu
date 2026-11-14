// The profile's strategy documents for the Strategies tab (Python `service/strategy_docs.py`,
// docs/agents/strategies.md stage 1). A strategy is a document the agent writes freely; YAML next to
// it is optional. Two sources:
// - main: `strategy.md` + `strategy.yaml` in the profile directory, the only one the app executes
//   (`services/strategy.ts`); listed even when missing so the tab can offer a template;
// - `strategies/`: `<id>.md` (+ `<id>.yaml`) one-file strategies and `<id>/` folder strategies,
//   shown read-only and not executed yet.
// Read-only: nothing here writes. Hidden entries, symlinks, other extensions and paths outside a
// strategy are ignored; a requested path is checked against the listing, segment by segment.
import { PY_WS, pyLower, pyStrip } from "@cashu/domain";
import { isPyMap, pyStr, safeLoadYaml } from "@cashu/domain/pyYaml";

/** Cannot collide with a folder id (those start with a letter or digit). */
export const MAIN_ID = "_main";
export const MAIN_FILES = ["strategy.md", "strategy.yaml"] as const;
export const MAX_FILE_BYTES = 512_000;
export const MAX_FILES = 200;
export const MAX_DEPTH = 3;
const STRATEGIES = "strategies";
/** PARITY(S22b): Python's `re.match(... $)` also accepts one trailing newline; this refuses it. */
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KINDS: Readonly<Record<string, FileKind>> = {
  ".md": "md",
  ".markdown": "md",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".txt": "text",
  ".json": "text",
};
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/**
 * Python `re.compile(r"^#\s+(.+?)\s*#*\s*$", re.MULTILINE)`: `^` / `$` at a `\n` only, `.` anything
 * but `\n`, `\s` Python's (JavaScript's `m` flag and `.` also break at `\r`, U+2028, U+2029).
 */
const HEADING = new RegExp(`(?<=^|\n)#[${PY_WS}]+([^\n]+?)[${PY_WS}]*#*[${PY_WS}]*(?=\n|$)`, "u");

export type FileKind = "md" | "yaml" | "text";

/** One directory entry as `lstat` sees it (a symlink is never followed). */
export interface DirEntry {
  readonly name: string;
  readonly kind: "file" | "dir" | "symlink" | "other";
  /** Bytes (files). */
  readonly size: number;
}

/**
 * The profile directory, read only. Paths are segments relative to it (`[]` = the profile directory,
 * `["strategies", "swing"]`); the adapter joins them under the directory of a slug checked with
 * `checkedProfileSlug` and never follows a symlink at any segment.
 */
export interface StrategyDocsDir {
  /** The entries of a directory, or null when it is not a directory or cannot be read. */
  list(path: readonly string[]): Promise<readonly DirEntry[] | null>;
  /** A file's text, invalid UTF-8 replaced (U+FFFD); null when it cannot be read. */
  readText(path: readonly string[]): Promise<string | null>;
}

/** Python `StrategyDoc`. */
export interface StrategyDoc {
  readonly id: string;
  /** The strategy's folder, as segments relative to the profile directory. */
  readonly root: readonly string[];
  /** Relative POSIX paths, sorted: the main document first. */
  readonly files: readonly string[];
  readonly mainMd: string | null;
  /** For a one-file strategy: the stem; its files sit next to other strategies in `strategies/`. */
  readonly single: string | null;
}

/** Python `Path(name).suffix`. */
function suffix(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i) : "";
}

/** Python `Path(name).stem`. */
function stem(name: string): string {
  const s = suffix(name);
  return s ? name.slice(0, -s.length) : name;
}

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Python `_kind`. */
function kindOf(path: string): FileKind | null {
  return KINDS[pyLower(suffix(baseName(path)))] ?? null;
}

/** Python `_visible`: not hidden and not a symlink. */
const visible = (e: DirEntry) => !e.name.startsWith(".") && e.kind !== "symlink";

/** Python `str` comparison: by code point (JS `<` compares UTF-16 units). */
function compareText(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i]?.codePointAt(0) ?? 0) - (y[i]?.codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** `sorted(entries, key=lambda p: p.name.lower())` (stable). */
const byLowerName = (entries: readonly DirEntry[]) =>
  [...entries].sort((a, b) => compareText(pyLower(a.name), pyLower(b.name)));

/** Python `_walk`: listed files below `root`, at most MAX_DEPTH levels and MAX_FILES files. */
async function walk(dir: StrategyDocsDir, root: readonly string[], depth = 0): Promise<string[]> {
  let out: string[] = [];
  const entries = await dir.list(root);
  if (entries === null) return out;
  for (const e of byLowerName(entries)) {
    if (!visible(e)) continue;
    if (e.kind === "dir" && depth + 1 < MAX_DEPTH) {
      const sub = await walk(dir, [...root, e.name], depth + 1);
      out = out.concat(sub.map((s) => `${e.name}/${s}`));
    } else if (e.kind === "file" && kindOf(e.name) !== null) {
      out.push(e.name);
    }
    if (out.length >= MAX_FILES) break;
  }
  return out.slice(0, MAX_FILES);
}

/** Python `_pick_main_md`. */
function pickMainMd(paths: readonly string[], stemName: string | null = null): string | null {
  const mds = paths.filter((p) => kindOf(p) === "md");
  for (const preferred of [
    stemName ? `${stemName}.md` : null,
    "strategy.md",
    "README.md",
    "index.md",
  ]) {
    if (preferred !== null && mds.includes(preferred)) return preferred;
  }
  const top = mds.filter((p) => !p.includes("/"));
  return (top.length > 0 ? top : mds)[0] ?? null;
}

/**
 * Python `discover`: main first, then the `strategies/` entries by id.
 * PARITY(S22b): Python lists a main file that is a symlink to a file (and then fails to read it when
 * the link leaves the profile directory); here a symlinked main file is not listed.
 */
export async function discoverStrategies(dir: StrategyDocsDir): Promise<StrategyDoc[]> {
  const top = (await dir.list([])) ?? [];
  const mainFiles = MAIN_FILES.filter((n) => top.some((e) => e.name === n && e.kind === "file"));
  const docs: StrategyDoc[] = [
    {
      id: MAIN_ID,
      root: [],
      files: mainFiles,
      mainMd: mainFiles.includes("strategy.md") ? "strategy.md" : null,
      single: null,
    },
  ];
  if (!top.some((e) => e.name === STRATEGIES && e.kind === "dir")) return docs;
  const entries = (await dir.list([STRATEGIES])) ?? [];
  const singles = new Map<string, string[]>();
  const folders = new Map<string, StrategyDoc>();
  for (const e of byLowerName(entries)) {
    if (!visible(e)) continue;
    const kind = kindOf(e.name);
    const id = pyLower(stem(e.name));
    if (e.kind === "dir" && ID.test(e.name)) {
      const found = await walk(dir, [STRATEGIES, e.name]);
      folders.set(e.name, {
        id: e.name,
        root: [STRATEGIES, e.name],
        files: found,
        mainMd: pickMainMd(found),
        single: null,
      });
    } else if (e.kind === "file" && (kind === "md" || kind === "yaml") && ID.test(id)) {
      const names = singles.get(id) ?? [];
      names.push(e.name);
      singles.set(id, names);
    }
  }
  for (const [id, names] of singles) {
    if (folders.has(id)) continue; // a folder of the same id wins
    names.sort((a, b) => {
      const ma = kindOf(a) === "md" ? 0 : 1;
      const mb = kindOf(b) === "md" ? 0 : 1;
      return ma !== mb ? ma - mb : compareText(a, b);
    });
    folders.set(id, {
      id,
      root: [STRATEGIES],
      files: names,
      mainMd: pickMainMd(names, id),
      single: id,
    });
  }
  return docs.concat(
    [...folders.keys()].sort(compareText).map((k) => folders.get(k) as StrategyDoc),
  );
}

export type StrategyFileText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "no_file" | "too_large" };

/**
 * Python `read_text`: one listed file of the strategy. The path must be in `doc.files`, and every
 * segment is checked again against the directory listing (a directory, then a regular file: never a
 * symlink), so a file swapped for a link after listing is not read.
 */
export async function readStrategyFile(
  dir: StrategyDocsDir,
  doc: StrategyDoc,
  rel: string,
): Promise<StrategyFileText> {
  if (!doc.files.includes(rel)) return { ok: false, reason: "no_file" };
  const parts = rel.split("/");
  let at: readonly string[] = doc.root;
  let file: DirEntry | undefined;
  for (const [i, part] of parts.entries()) {
    const entry = ((await dir.list(at)) ?? []).find((e) => e.name === part);
    const last = i === parts.length - 1;
    if (entry === undefined || entry.kind !== (last ? "file" : "dir")) {
      return { ok: false, reason: "no_file" };
    }
    at = [...at, part];
    file = entry;
  }
  if (file === undefined) return { ok: false, reason: "no_file" };
  if (file.size > MAX_FILE_BYTES) return { ok: false, reason: "too_large" };
  const text = await dir.readText(at);
  return text === null ? { ok: false, reason: "no_file" } : { ok: true, text };
}

/**
 * Python `frontmatter`: (string fields of a leading `---` YAML block, the text after it); a broken
 * block is ignored. Fields: text, integer, float and boolean values (Python's `bool` is an `int`),
 * rendered like `str()` and stripped; empty ones are dropped.
 */
export function frontmatter(mdText: string): {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
} {
  const m = FRONTMATTER.exec(mdText);
  if (m === null) return { fields: {}, body: mdText };
  const loaded = safeLoadYaml(m[1] ?? "");
  if (!loaded.ok || !isPyMap(loaded.value)) return { fields: {}, body: mdText };
  const fields: Record<string, string> = {};
  for (const [k, v] of loaded.value) {
    if (
      typeof v !== "string" &&
      typeof v !== "bigint" &&
      typeof v !== "number" &&
      typeof v !== "boolean"
    ) {
      continue;
    }
    const text = pyStrip(pyStr(v));
    if (text) fields[k] = text;
  }
  return { fields, body: mdText.slice(m[0].length) };
}

/** Python `summary`: the list entry of one strategy. */
export interface StrategyDocSummary {
  readonly id: string;
  readonly main: boolean;
  readonly executed: boolean;
  /** Frontmatter title, else the first heading, else null for main and the id for the others. */
  readonly title: string | null;
  readonly status: string | null;
  readonly description: string | null;
  readonly mainFile: string | null;
  /**
   * The folder the files are relative to, as a POSIX path relative to the profile directory (`""` for
   * main). PARITY(S22b): Python sends the absolute path; the surface (S36) prefixes the directory.
   */
  readonly root: string;
  readonly files: readonly { readonly path: string; readonly kind: FileKind | null }[];
}

export async function strategySummary(
  dir: StrategyDocsDir,
  doc: StrategyDoc,
): Promise<StrategyDocSummary> {
  let meta: Readonly<Record<string, string>> = {};
  let heading: string | null = null;
  if (doc.mainMd !== null) {
    const read = await readStrategyFile(dir, doc, doc.mainMd);
    let body = "";
    if (read.ok) ({ fields: meta, body } = frontmatter(read.text));
    const h = HEADING.exec(body);
    heading = h ? pyStrip(h[1] ?? "") : null;
  }
  return {
    id: doc.id,
    main: doc.id === MAIN_ID,
    executed: doc.id === MAIN_ID,
    title: meta.title || heading || (doc.id === MAIN_ID ? null : doc.id),
    status: meta.status ?? null,
    description: meta.description ?? null,
    mainFile: doc.mainMd,
    root: doc.root.join("/"),
    files: doc.files.map((path) => ({ path, kind: kindOf(path) })),
  };
}
