import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { MigrationError } from "./contract.js";
import {
  assertPrivateStagingSeal,
  assertSameSource,
  type PythonDatabaseName,
  type SourceEntry,
  type SourceSeal,
  sealPythonSource,
} from "./sourceSeal.js";

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncEntryDirectories(root: string, entries: readonly SourceEntry[]): void {
  const directories = new Set([root]);
  for (const entry of entries) {
    let current = dirname(join(root, entry.path));
    while (current !== root) {
      directories.add(current);
      current = dirname(current);
    }
  }
  for (const path of [...directories].sort((a, b) => b.length - a.length)) syncDirectory(path);
}

/** Files and their parent directories must keep the same identity across the offline copy. */
function metadataSignature(root: string, entries: readonly SourceEntry[]): string {
  const paths = new Set<string>([root]);
  for (const entry of entries) {
    const file = join(root, entry.path);
    paths.add(file);
    let parent = dirname(file);
    while (parent !== root) {
      paths.add(parent);
      parent = dirname(parent);
    }
  }
  return JSON.stringify(
    [...paths]
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map((path) => {
        const stat = lstatSync(path, { bigint: true });
        return [
          path.slice(root.length),
          stat.dev.toString(),
          stat.ino.toString(),
          stat.mode.toString(),
          stat.uid.toString(),
          stat.gid.toString(),
          stat.nlink.toString(),
          stat.size.toString(),
          stat.mtimeNs.toString(),
          stat.ctimeNs.toString(),
        ];
      }),
  );
}

function copyPrivate(sourceRoot: string, targetRoot: string, entry: SourceEntry): void {
  const source = join(sourceRoot, entry.path);
  const target = join(targetRoot, entry.path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const from = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(from);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.bytes) {
      throw new MigrationError("source_changed");
    }
    const to = openSync(
      target,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      for (;;) {
        const n = readSync(from, chunk, 0, chunk.length, null);
        if (n === 0) break;
        total += n;
        hash.update(chunk.subarray(0, n));
        for (let offset = 0; offset < n; ) offset += writeSync(to, chunk, offset, n - offset);
      }
      if (total !== entry.bytes || hash.digest("hex") !== entry.sha256) {
        throw new MigrationError("source_changed");
      }
      fsyncSync(to);
    } finally {
      closeSync(to);
    }
  } finally {
    closeSync(from);
  }
}

function quickCheck(path: string): void {
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare("PRAGMA quick_check").all() as { quick_check?: unknown }[];
      if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
        throw new MigrationError("snapshot_unverified");
      }
    } finally {
      db.close();
    }
  } catch {
    throw new MigrationError("snapshot_unverified");
  }
}

/**
 * Offline native SQLite snapshot. The caller must stop every Python writer and keep them stopped.
 * It never opens the original database through SQLite. It nofollow-copies the exact DB, WAL/SHM
 * and side files to private staging, then backs up the copied WAL database into one canonical DB.
 * Source bytes and filesystem identity are checked before and after the copy.
 */
async function snapshotSqliteRaw(
  sourceRoot: string,
  destination: string,
  expected: SourceSeal,
  database: PythonDatabaseName,
): Promise<void> {
  const source = sealPythonSource(sourceRoot, database);
  assertSameSource(expected, source);
  const metadata = metadataSignature(sourceRoot, source.entries);
  if (
    resolve(destination) !== destination ||
    destination === sourceRoot ||
    destination.startsWith(`${sourceRoot}${sep}`)
  ) {
    throw new MigrationError("source_unsafe");
  }
  const parent = dirname(destination);
  if (realpathSync(parent) !== parent) throw new MigrationError("source_unsafe");
  mkdirSync(destination, { mode: 0o700 });
  const raw = join(destination, "raw");
  mkdirSync(raw, { mode: 0o700 });
  for (const entry of source.entries) {
    copyPrivate(sourceRoot, raw, entry);
  }
  syncEntryDirectories(raw, source.entries);
  const copied = sealPythonSource(raw, database);
  assertPrivateStagingSeal(copied);
  if (copied.digest !== source.digest) throw new MigrationError("source_changed");
  const rawDb = join(raw, database);
  quickCheck(rawDb);
  try {
    const db = new DatabaseSync(rawDb, { readOnly: true });
    try {
      await backup(db, join(destination, "cashu.db"));
    } finally {
      db.close();
    }
  } catch {
    throw new MigrationError("snapshot_unverified");
  }
  const canonical = join(destination, "cashu.db");
  chmodSync(canonical, 0o600);
  try {
    const db = new DatabaseSync(canonical);
    try {
      db.exec("PRAGMA journal_mode=DELETE");
    } finally {
      db.close();
    }
  } catch {
    throw new MigrationError("snapshot_unverified");
  }
  if (
    lstatSync(`${canonical}-wal`, { throwIfNoEntry: false }) ||
    lstatSync(`${canonical}-shm`, { throwIfNoEntry: false })
  )
    throw new MigrationError("snapshot_unverified");
  quickCheck(canonical);
  const canonicalFd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(canonicalFd);
  } finally {
    closeSync(canonicalFd);
  }
  for (const entry of source.entries) {
    if (
      entry.path === database ||
      entry.path === `${database}-wal` ||
      entry.path === `${database}-shm`
    )
      continue;
    copyPrivate(raw, destination, entry);
  }
  syncEntryDirectories(
    destination,
    source.entries.filter((entry) => !entry.path.startsWith(database)),
  );
  rmSync(raw, { recursive: true });
  syncDirectory(destination);
  syncDirectory(parent);
  assertSameSource(source, sealPythonSource(sourceRoot, database));
  if (metadataSignature(sourceRoot, source.entries) !== metadata) {
    throw new MigrationError("source_changed");
  }
  assertPrivateStagingSeal(sealPythonSource(destination));
}

/** Public failures are code-only; OS paths and SQLite diagnostics stay private. */
export async function snapshotSqliteAndSideFilesOffline(
  sourceRoot: string,
  destination: string,
  expected: SourceSeal,
  database: PythonDatabaseName = "cashu.db",
): Promise<void> {
  try {
    await snapshotSqliteRaw(sourceRoot, destination, expected, database);
  } catch (error) {
    if (error instanceof MigrationError) throw error;
    throw new MigrationError("snapshot_unverified");
  }
}
