// The source side of `cashu-next genesis` (S26 spec 8.5, 9.4): the data dir is never opened, only
// hashed (golden.py `manifest` semantics) and copied into a private run dir; the copy is what
// genesis reads. A source that changes while the run copies or reads it fails the run.
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import type * as genesis from "@cashu/store/genesis";

/** The database files and side-file folders a run copies (spec 2.1). */
const DB_FILES = ["cashu.db", "cashu.db-wal", "cashu.db-shm"] as const;
const SIDE_DIRS = ["profiles", "imports"] as const;

/** The source manifest: file count and the sha256 over `shasum -a 256` lines (golden.py). */
export interface SourceManifest {
  readonly files: number;
  readonly sha256: string;
}

/** The data dir changed during the run (exit 65). */
export class SourceChangedError extends Error {
  readonly exitCode = 65;

  constructor() {
    super("the data dir changed during the run");
    this.name = "SourceChangedError";
  }
}

function fileSha256(path: string): string {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(path, "r");
  try {
    for (let n = readSync(fd, buf); n > 0; n = readSync(fd, buf)) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Relative paths (`/` separated) of every file under `root`, as Python's `rglob("*")` + `is_file()`
 * sees them: symlinked files count, symlinked directories are not descended into.
 */
function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(root, path));
    else if (entry.isFile()) out.push(path);
    else if (
      entry.isSymbolicLink() &&
      statSync(join(root, path), { throwIfNoEntry: false })?.isFile()
    ) {
      out.push(path);
    }
  }
  return out;
}

/** Python's `str` order (code points) equals the byte order of UTF-8. */
const byCodePoint = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** golden.py `manifest(root)`: every file of the dir, sorted, `<sha256>  ./<rel>\n` lines hashed. */
export function manifest(root: string): SourceManifest {
  const files = listFiles(root)
    .map((rel) => `./${rel}`)
    .sort(byCodePoint);
  const lines = files.map((rel) => `${fileSha256(join(root, rel.slice(2)))}  ${rel}\n`);
  return {
    files: files.length,
    sha256: createHash("sha256").update(lines.join(""), "utf8").digest("hex"),
  };
}

export function assertUnchanged(before: SourceManifest, after: SourceManifest): void {
  if (before.files !== after.files || before.sha256 !== after.sha256) {
    throw new SourceChangedError();
  }
}

/** Regular files and folders only (a symlink in a side folder is not followed). */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) copyTree(join(from, entry.name), join(to, entry.name));
    else if (entry.isFile()) copyFileSync(join(from, entry.name), join(to, entry.name));
  }
}

/** Copies the database files and side folders of `dataDir` into the (new, empty) `runDir`. */
export function copyRun(dataDir: string, runDir: string): void {
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  for (const name of DB_FILES) {
    const from = join(dataDir, name);
    if (lstatSync(from, { throwIfNoEntry: false })?.isFile())
      copyFileSync(from, join(runDir, name));
  }
  for (const name of SIDE_DIRS) {
    const from = join(dataDir, name);
    if (lstatSync(from, { throwIfNoEntry: false })?.isDirectory())
      copyTree(from, join(runDir, name));
  }
}

/** `rel` as a path inside `root`; undefined for an absolute path or one that climbs out. */
function inside(root: string, rel: string): string | undefined {
  if (isAbsolute(rel)) return undefined;
  const norm = normalize(rel);
  if (norm === ".." || norm.startsWith(`..${sep}`)) return undefined;
  return join(root, norm);
}

/** The run copy's side files as genesis reads them (spec 9.2 `GenesisFiles`). */
export function runFiles(runDir: string): genesis.GenesisFiles {
  return {
    read(rel) {
      const path = inside(runDir, rel);
      if (path === undefined || !lstatSync(path, { throwIfNoEntry: false })?.isFile()) {
        return undefined;
      }
      return new Uint8Array(readFileSync(path));
    },
    list(dir) {
      const path = inside(runDir, dir);
      if (path === undefined || !lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) {
        return [];
      }
      return readdirSync(path, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
        .sort(byCodePoint);
    },
  };
}
