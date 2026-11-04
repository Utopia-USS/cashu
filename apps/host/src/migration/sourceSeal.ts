import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MigrationError } from "./contract.js";

export interface SourceEntry {
  /** Private relative path, never sent to the renderer or count-only log. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SourceSeal {
  readonly format: 1;
  readonly database: "cashu.db" | "finanse.db";
  /** Private canonical identity of the selected Python source root. */
  readonly root: string;
  readonly entries: readonly SourceEntry[];
  /** SHA-256 over the canonical sorted entry list. Safe for status/report output. */
  readonly digest: string;
}

/**
 * Process/UI files outside the financial copy. Other roots require explicit one-shot import policy.
 */
const DEVICE_LOCAL_EXCLUSIONS = new Set([
  "api-token",
  "app-location.json",
  "desktop.json",
  // Owner-approved one-shot omission: Enable Banking reconnects with fresh consent.
  "eb_sessions.json",
  "enablebanking_private.pem",
  // Owner-approved one-shot device preferences and completed rename marker.
  "settings.json",
  "rename-migration.json",
  // Installed Python connector code and local approvals require native reinstall/reapproval.
  "connectors",
  "backups",
  "locks",
  "logs",
  "tmp",
]);
export type PythonDatabaseName = "cashu.db" | "finanse.db";
const GENESIS_ROOTS = new Set(["profiles", "imports"]);

function assertKnownRoots(root: string, database: PythonDatabaseName): void {
  const databaseRoots = new Set([database, `${database}-wal`, `${database}-shm`]);
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (databaseRoots.has(name)) continue;
    if (GENESIS_ROOTS.has(name)) {
      statPrivate(path, "directory");
      continue;
    }
    if (name === "market") {
      statPrivate(path, "directory");
      if (readdirSync(path).some((child) => child !== "calendar.json")) {
        throw new MigrationError("semantic_difference");
      }
      continue;
    }
    if (DEVICE_LOCAL_EXCLUSIONS.has(name)) {
      const stat = lstatSync(path);
      statPrivate(
        path,
        name === "connectors" ? "directory" : stat.isDirectory() ? "directory" : "file",
      );
      continue;
    }
    // Financial or unclassified side state is never silently omitted from an offline import.
    throw new MigrationError("semantic_difference");
  }
}

function statPrivate(path: string, kind: "file" | "directory"): Stats {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw new MigrationError("source_unsafe");
  }
  const mode = stat.mode & 0o777;
  if (
    (kind === "file"
      ? !stat.isFile() || stat.nlink !== 1 || (mode & 0o400) === 0 || (mode & 0o022) !== 0
      : !stat.isDirectory() || (mode & 0o500) !== 0o500 || (mode & 0o022) !== 0) ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    realpathSync(path) !== path
  ) {
    throw new MigrationError("source_unsafe");
  }
  return stat;
}

/** New private staging is stricter than an older owner-owned source tree. */
export function assertPrivateStagingSeal(seal: SourceSeal): void {
  try {
    const root = lstatSync(seal.root);
    if ((root.mode & 0o777) !== 0o700) throw new MigrationError("snapshot_unverified");
    for (const entry of seal.entries) {
      const file = lstatSync(join(seal.root, entry.path));
      if ((file.mode & 0o777) !== 0o600) throw new MigrationError("snapshot_unverified");
      let dir = dirname(join(seal.root, entry.path));
      while (dir !== seal.root) {
        if ((lstatSync(dir).mode & 0o777) !== 0o700) {
          throw new MigrationError("snapshot_unverified");
        }
        dir = dirname(dir);
      }
    }
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("snapshot_unverified");
  }
}

function shaFile(path: string, initial: Stats): SourceEntry {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new MigrationError("source_unsafe");
  }
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino ||
      opened.size !== initial.size ||
      opened.mtimeMs !== initial.mtimeMs ||
      opened.nlink !== 1
    )
      throw new MigrationError("source_changed");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      bytes += n;
      hash.update(chunk.subarray(0, n));
    }
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      bytes !== initial.size ||
      after.size !== initial.size ||
      after.mtimeMs !== initial.mtimeMs ||
      pathAfter.dev !== initial.dev ||
      pathAfter.ino !== initial.ino ||
      pathAfter.size !== initial.size ||
      pathAfter.mtimeMs !== initial.mtimeMs
    )
      throw new MigrationError("source_changed");
    return { path: "", bytes, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

function optionalFile(root: string, relative: string): SourceEntry | undefined {
  const path = join(root, relative);
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new MigrationError("source_unsafe");
  }
  statPrivate(path, "file");
  return { ...shaFile(path, stat), path: relative };
}

function walk(root: string, relative: string, entries: SourceEntry[]): void {
  const path = join(root, relative);
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new MigrationError("source_unsafe");
  }
  statPrivate(path, "directory");
  for (const name of readdirSync(path).sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )) {
    const child = `${relative}/${name}`;
    const childPath = join(root, child);
    const stat = lstatSync(childPath);
    if (stat.isDirectory()) walk(root, child, entries);
    else {
      statPrivate(childPath, "file");
      entries.push({ ...shaFile(childPath, stat), path: child });
    }
  }
}

/**
 * Read-only byte seal for the Python DB, its exact WAL/SHM companions and genesis side trees.
 * It does not stop writers or establish SQLite consistency; offline import requires Python stopped.
 */
function sealSource(root: string, database: PythonDatabaseName): SourceSeal {
  if (resolve(root) !== root) throw new MigrationError("source_unsafe");
  statPrivate(root, "directory");
  assertKnownRoots(root, database);
  const db = optionalFile(root, database);
  if (!db) throw new MigrationError("source_unsafe");
  const entries = [db];
  for (const suffix of ["-wal", "-shm"]) {
    const entry = optionalFile(root, `${database}${suffix}`);
    if (entry) entries.push(entry);
  }
  walk(root, "profiles", entries);
  walk(root, "imports", entries);
  const calendar = optionalFile(root, "market/calendar.json");
  if (calendar) entries.push(calendar);
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const digest = createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  return { format: 1, database, root, entries, digest };
}

/** Public errors carry a stable code only, never a source path or OS error text. */
export function sealPythonSource(
  root: string,
  database: PythonDatabaseName = "cashu.db",
): SourceSeal {
  try {
    return sealSource(root, database);
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("source_unsafe");
  }
}

/** Refuse a changed source, even if the DB itself still hashes the same. */
export function assertSameSource(before: SourceSeal, after: SourceSeal): void {
  if (
    before.format !== after.format ||
    before.root !== after.root ||
    before.database !== after.database ||
    before.digest !== after.digest
  ) {
    throw new MigrationError("source_changed");
  }
}
