// `<checkout>/.env.dev` exactly as the Python app reads it (`src/cashu/_devenv.py`), so the shim and
// every Python process of a dev checkout land on the same data dir. A source checkout is the repo
// root holding both `pyproject.toml` and `.git`; a linked git worktree also reads its main checkout's
// file (nearest first). Nothing is read without a checkout (the packaged app) or under the test suite
// (`CASHU_TESTING`). Only `CASHU_*` keys count, and they fill only variables the environment does not
// set already (the shell always wins). Parsing: Python `str.splitlines`, `str.strip`, `KEY=VALUE`,
// `#` comments, an `export ` prefix, one pair of matching quotes, `~` expanded at the start.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pyStrip } from "@cashu/domain/text";
import { expandUser, purePath, pyRealpath } from "./pypath.js";

const FILENAME = ".env.dev";
const PREFIX = "CASHU_";

/** Python `str.splitlines()` boundaries (code points; CR LF counts as one). */
const BREAKS = new Set([0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);

/** Python `str.splitlines()` (no trailing empty line). */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!BREAKS.has(code)) continue;
    lines.push(text.slice(start, i));
    if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) i++;
    start = i + 1;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

export type Env = Readonly<Record<string, string | undefined>>;

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** `root` when it is a source checkout (pyproject.toml + .git), else undefined. */
export function checkoutRoot(root: string): string | undefined {
  return isFile(join(root, "pyproject.toml")) && existsSync(join(root, ".git")) ? root : undefined;
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** `_main_checkout`: the main checkout of a linked worktree, undefined for anything else. */
export function mainCheckout(root: string, cwd: string): string | undefined {
  const git = join(root, ".git");
  if (!isFile(git)) return undefined;
  let first: string | undefined;
  try {
    first = splitLines(readFileSync(git, "utf8"))[0];
  } catch {
    return undefined;
  }
  if (first === undefined || first === "" || !first.startsWith("gitdir:")) return undefined;
  const raw = pyStrip(first.slice("gitdir:".length));
  // Path(raw); a relative one is resolved against the checkout (symlinks too).
  const gitdir = raw.startsWith("/") ? purePath(raw) : pyRealpath(`${root}/${raw}`, cwd);
  const parent = parentOf(gitdir);
  if (nameOf(parent) !== "worktrees" || nameOf(parentOf(parent)) !== ".git") return undefined;
  return parentOf(parentOf(parent));
}

/** `_parse`: the `CASHU_*` pairs of one file's text, a later line winning. */
export function parseDevEnv(text: string, home: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of splitLines(text)) {
    const line = pyStrip(raw);
    if (line === "" || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    let key = pyStrip(line.slice(0, at));
    let value = pyStrip(line.slice(at + 1));
    if (key.startsWith("export ")) key = pyStrip(key.slice("export ".length));
    if (!key.startsWith(PREFIX)) continue;
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    values.set(key, expandUser(value, home));
  }
  return values;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function readDevEnv(path: string, home: string): Map<string, string> {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch {
    return new Map();
  }
  // Python's read_text raises on invalid UTF-8 (the Python CLI stops there); so does the shim.
  return parseDevEnv(decoder.decode(bytes), home);
}

export interface DevEnv {
  /** The files read, nearest first. */
  readonly files: readonly string[];
  /** The variables they set that the environment did not have (what Python's `load` adds). */
  readonly added: Readonly<Record<string, string>>;
}

/** `load`: what `.env.dev` adds to `env` for the checkout `root` (undefined: no checkout). */
export function loadDevEnv(root: string | undefined, env: Env, home: string, cwd: string): DevEnv {
  if (root === undefined || env.CASHU_TESTING) return { files: [], added: {} };
  const found = [join(root, FILENAME)];
  const main = mainCheckout(root, cwd);
  if (main !== undefined) found.push(join(main, FILENAME));
  const files = found.filter(isFile);
  const added: Record<string, string> = {};
  for (const file of files) {
    for (const [key, value] of readDevEnv(file, home)) {
      if (env[key] === undefined && added[key] === undefined) added[key] = value;
    }
  }
  return { files, added };
}
