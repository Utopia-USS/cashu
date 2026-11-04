// `cashu migrate`: the all-or-nothing, in-place import of the Python app's data dir D into the native
// app, in the same D. Stages, in order (each reported through `onProgress`):
//   preflight  D holds Python data and no native inventory; the host lock of D is held for the whole
//              run; an orphan KEK of a failed attempt (D's namespace, no inventory) is removed.
//   copy       the Python entries are hashed (relative path, size, sha256) and the ones the importer
//              reads are copied into `D/.migration-<time>/source` and checked against that manifest.
//   import     `importPythonDataDir` from that copy into `D/.migration-<time>/native`; its KEK goes
//              into D's key store namespace (`scopeDir`), so the tree opens unchanged once moved.
//   verify     `verifyPythonMigration` of the staged pair, then the originals are hashed again and
//              must match the manifest (else the Python app wrote meanwhile: source_changed).
//   cutover    a journal is written, every Python top-level entry is renamed into
//              `D/python-backup-<time>/` (contents untouched), every native entry into D, then
//              `D/migration.json` is written and the staging removed. Every move is idempotent: a
//              rerun finds the journal and finishes forward.
// Any failure before the cutover removes the staging and the KEK this run created; the originals
// were only read. A failure during the cutover keeps the journal (`migration_incomplete`). Errors are
// `StartupFailureError`s carrying only allow-listed codes, never a path or a value.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  DIAGNOSTICS_DIR,
  failureDetail,
  type MigrateStage,
  type StartupFailureCode,
  type StartupFailureDetail,
  StartupFailureError,
} from "@cashu/host-protocol/startup-failure";
import { acquireHostLock, ensurePrivateDir, type HostLock, hostRunPaths } from "@cashu/node-host";
import {
  legacyDataAdmission,
  MIGRATION_JOURNAL,
  MIGRATION_MARKER,
  MIGRATION_STAGING_PREFIX,
  migrationJournals,
  PYTHON_BACKUP_PREFIX,
} from "@cashu/node-host/admission";
import {
  createProductionKeyStore,
  type MigrationKek,
  productionMigrationKek,
} from "@cashu/node-host/keyring";
import { z } from "zod";
import { NATIVE_INVENTORY } from "../nativeInventory.js";
import { MigrationError } from "./contract.js";
import {
  importPythonDataDir,
  type KeyStoreFactory,
  type OneShotResult,
  verifyPythonMigration,
} from "./oneShot.js";
import { DEVICE_LOCAL_EXCLUSIONS, GENESIS_ROOTS } from "./sourceSeal.js";

const DATABASES = ["cashu.db", "finanse.db"] as const;
const DATABASE_SIDES = ["-wal", "-shm", "-journal"] as const;
const DATABASE_ENTRIES: readonly string[] = DATABASES.flatMap((db) => [
  db,
  ...DATABASE_SIDES.map((side) => `${db}${side}`),
]);

/** Top-level entries of a Python data dir: moved into the backup by the cutover. */
const PYTHON_ENTRIES: ReadonlySet<string> = new Set([
  ...DATABASE_ENTRIES,
  ...GENESIS_ROOTS,
  "market",
  ...DEVICE_LOCAL_EXCLUSIONS,
]);
/** The Python entries the importer reads (the rest is only hashed and moved). */
const IMPORTED_ENTRIES: ReadonlySet<string> = new Set([
  ...DATABASE_ENTRIES,
  ...GENESIS_ROOTS,
  "market",
]);
/**
 * Entries the native shell may create in D before the import (Electron main, the shim, the host
 * lock, the recovery screen's diagnostics). They are neither Python data nor native inventory and
 * stay where they are.
 */
const NATIVE_SHELL_ENTRIES: ReadonlySet<string> = new Set([
  "run",
  DIAGNOSTICS_DIR,
  "desktop-electron",
  "bin",
  "update-main-capability.json",
  "update-preferences.json",
]);
/** The native tree an import publishes; any of them in D before the cutover means native data. */
const NATIVE_TREE_ENTRIES: ReadonlySet<string> = new Set([
  "native",
  "stores",
  "vaults",
  "vault-secrets",
  "workspace",
]);
/** Finder metadata, ignored wherever it appears at the root. */
const IGNORED_ENTRIES: ReadonlySet<string> = new Set([".DS_Store"]);
/** The native shell's own logs inside the shared `logs/`: appended while we run, never hashed. */
const SHELL_LOG = /^(?:electron|host)\.log(?:\.\d{1,3})?$/;

export interface InPlaceKeychain {
  /** The key store factory; the migration passes `scopeDir` (D) for the staged tree. */
  readonly makeKeyStore: KeyStoreFactory;
  /** D's KEK (orphan removal before the import, cleanup after a failed one). */
  readonly kek: MigrationKek;
}

export interface InPlaceInput {
  /** D: the canonical absolute data dir. */
  readonly dataDir: string;
  /** The import time (ms); it names the staging and backup directories. */
  readonly at: number;
  /** Saves (or shows and confirms) the one-use recovery words before any target artifact exists. */
  readonly saveRecoveryWords: (words: string) => Promise<void>;
  /** Called as each stage starts. */
  readonly onProgress?: (stage: MigrateStage) => void;
  /** Synthetic test namespace only; production uses D's OS key store namespace. */
  readonly keychain?: InPlaceKeychain;
  /** Fault injection for tests: called after each cutover rename with the count so far. */
  readonly afterCutoverMove?: (moves: number) => void;
}

const count = z.number().int().min(0).max(1_000_000_000);
const backupName = z.string().regex(/^python-backup-[A-Za-z0-9_-]{1,64}$/);
const entryName = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0"));

const markerSchema = z.strictObject({
  version: z.literal(1),
  at: z.number().int().min(0),
  backupDir: backupName,
  profiles: count,
  financialTables: count,
  financialRows: count,
  vaults: count,
});
/** `D/migration.json`: when, where the originals went, and counts. No path outside D, no data. */
export type MigrationMarker = z.infer<typeof markerSchema>;

const journalSchema = z.strictObject({
  format: z.literal(1),
  phase: z.literal("cutover"),
  at: z.number().int().min(0),
  backupDir: backupName,
  python: z.array(entryName).max(256),
  native: z.array(entryName).max(256),
  result: z.strictObject({
    profiles: count,
    financialTables: count,
    financialRows: count,
    vaults: count,
  }),
});
type Journal = z.infer<typeof journalSchema>;

export interface InPlaceResult {
  readonly status: "migrated" | "already_migrated";
  readonly marker: MigrationMarker;
}

/** A failure of this run under `code`; a thrown value keeps its allow-listed detail. */
function fail(code: StartupFailureCode, detail?: StartupFailureDetail): never {
  throw new StartupFailureError(code, detail);
}

/** Re-throws under the code of the stage it happened in, keeping an allow-listed detail. */
function rethrowAs(
  error: unknown,
  code: StartupFailureCode,
  fallback: StartupFailureDetail,
): never {
  if (error instanceof StartupFailureError) {
    if (error.failure.code === code) throw error;
    fail(code, error.failure.detail ?? fallback);
  }
  fail(code, failureDetail(error) ?? fallback);
}

function present(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new MigrationError("source_unsafe");
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeFileDurably(path: string, bytes: Uint8Array): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    for (let offset = 0; offset < bytes.length; ) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new MigrationError("identity_invalid");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Writes `name` in `dir` through a temp file and a rename, then fsyncs the directory. */
function replaceFileDurably(dir: string, name: string, bytes: Uint8Array): void {
  const temp = join(dir, `${name}.tmp`);
  if (present(temp)) unlinkSync(temp);
  writeFileDurably(temp, bytes);
  renameSync(temp, join(dir, name));
  fsyncDirectory(dir);
}

function stamp(at: number): string {
  return new Date(at).toISOString().replace(/[-:.]/g, "");
}

// ---- the original files' manifest ------------------------------------------------------------

interface ManifestEntry {
  readonly path: string;
  readonly kind: "file" | "dir" | "link";
  readonly bytes?: number;
  readonly sha256?: string;
  readonly target?: string;
}

function hashFile(path: string, initial: Stats): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== initial.ino || opened.dev !== initial.dev)
      throw new MigrationError("source_changed");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(256 * 1024);
    let bytes = 0;
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      bytes += n;
      hash.update(chunk.subarray(0, n));
    }
    if (bytes !== initial.size || fstatSync(fd).size !== initial.size)
      throw new MigrationError("source_changed");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * Every file, directory and symlink under the given top-level entries of `root`, in a fixed order.
 * Symlinks are recorded by their target and never followed. The native shell's own logs are skipped.
 */
function manifest(root: string, names: readonly string[]): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  const visit = (relative: string) => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink())
      out.push({ path: relative, kind: "link", target: readlinkSync(path) });
    else if (stat.isFile())
      out.push({ path: relative, kind: "file", bytes: stat.size, sha256: hashFile(path, stat) });
    else if (stat.isDirectory()) {
      out.push({ path: relative, kind: "dir" });
      for (const child of readdirSync(path).sort(byteOrder)) {
        if (relative === "logs" && SHELL_LOG.test(child)) continue;
        visit(`${relative}/${child}`);
      }
    } else throw new MigrationError("source_unsafe");
  };
  for (const name of [...names].sort(byteOrder)) visit(name);
  return out;
}

const manifestDigest = (entries: readonly ManifestEntry[]) =>
  createHash("sha256").update(JSON.stringify(entries)).digest("hex");

/** Copies the imported entries into `destination` (0700 / 0600) and checks every byte against `entries`. */
function copyImported(root: string, destination: string, entries: readonly ManifestEntry[]): void {
  for (const entry of entries) {
    const top = entry.path.split("/")[0] ?? "";
    if (!IMPORTED_ENTRIES.has(top)) continue;
    const target = join(destination, entry.path);
    if (entry.kind === "link") throw new MigrationError("source_unsafe");
    if (entry.kind === "dir") {
      mkdirSync(target, { mode: 0o700 });
      continue;
    }
    const source = join(root, entry.path);
    const input = openSync(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const output = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const hash = createHash("sha256");
        const chunk = Buffer.allocUnsafe(256 * 1024);
        let bytes = 0;
        for (;;) {
          const n = readSync(input, chunk, 0, chunk.length, null);
          if (n === 0) break;
          for (let offset = 0; offset < n; ) {
            const written = writeSync(output, chunk, offset, n - offset);
            if (written <= 0) throw new MigrationError("snapshot_unverified");
            offset += written;
          }
          hash.update(chunk.subarray(0, n));
          bytes += n;
        }
        fsyncSync(output);
        if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256)
          throw new MigrationError("source_changed");
      } finally {
        closeSync(output);
      }
    } finally {
      closeSync(input);
    }
  }
  // The copy as written, read back: what the importer will seal is what the originals held.
  const copied = manifest(
    destination,
    readdirSync(destination).filter((name) => IMPORTED_ENTRIES.has(name)),
  );
  const expected = entries.filter((entry) => IMPORTED_ENTRIES.has(entry.path.split("/")[0] ?? ""));
  if (manifestDigest(copied) !== manifestDigest(expected))
    throw new MigrationError("snapshot_unverified");
}

// ---- D's state ---------------------------------------------------------------------------------

interface Inspection {
  readonly journals: readonly string[];
  readonly marker: MigrationMarker | null;
  readonly inventory: boolean;
  readonly admission: ReturnType<typeof legacyDataAdmission>;
}

function readMarker(dataDir: string): MigrationMarker | null {
  const path = join(dataDir, MIGRATION_MARKER);
  const stat = present(path);
  if (stat === null) return null;
  if (!stat.isFile() || stat.size > 4096) fail("migrate_import_failed", "source_unsafe");
  try {
    return markerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    fail("migrate_import_failed", "source_unsafe");
  }
}

function inspect(dataDir: string): Inspection {
  const journals = migrationJournals(dataDir);
  if (journals === "unreadable") fail("migrate_import_failed", "source_unsafe");
  return {
    journals,
    marker: readMarker(dataDir),
    inventory: present(join(dataDir, NATIVE_INVENTORY)) !== null,
    admission: legacyDataAdmission(dataDir),
  };
}

/** The Python top-level entries of D; anything unclassified refuses the run. */
function pythonEntries(dataDir: string): string[] {
  const python: string[] = [];
  for (const name of readdirSync(dataDir)) {
    if (PYTHON_ENTRIES.has(name)) python.push(name);
    else if (NATIVE_SHELL_ENTRIES.has(name) || IGNORED_ENTRIES.has(name)) continue;
    else if (name.startsWith(MIGRATION_STAGING_PREFIX)) continue;
    else if (NATIVE_TREE_ENTRIES.has(name) || name === MIGRATION_MARKER)
      fail("migrate_import_failed", "already_migrated");
    else if (name.startsWith(PYTHON_BACKUP_PREFIX)) fail("migrate_import_failed", "source_unsafe");
    // Financial or unclassified side state is never silently left behind.
    else fail("migrate_import_failed", "semantic_difference");
  }
  return python.sort(byteOrder);
}

function holdLock(dataDir: string): HostLock {
  const paths = hostRunPaths(dataDir);
  ensurePrivateDir(paths.runDir);
  const lock = acquireHostLock(paths.lockPath);
  if (!lock) fail("migrate_import_failed", "native_host_lock_required");
  return lock;
}

function canonicalDataDir(path: string): string {
  try {
    if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path)
      throw new Error("noncanonical");
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a directory");
  } catch {
    fail("migrate_import_failed", "source_unsafe");
  }
  return path;
}

function defaultKeychain(dataDir: string): InPlaceKeychain {
  return { makeKeyStore: createProductionKeyStore, kek: productionMigrationKek(dataDir) };
}

// ---- cutover -----------------------------------------------------------------------------------

function markerOf(journal: Journal): MigrationMarker {
  return { version: 1, at: journal.at, backupDir: journal.backupDir, ...journal.result };
}

/**
 * Moves `name` from `from` to `to` unless already moved; a name in both places is a conflict. A
 * device-local Python entry (never imported) gone from both places counts as moved, so a stray
 * temp or lock file that vanished cannot hold the cutover half done forever.
 */
function moveOnce(from: string, to: string, name: string, sharedLogs = false): boolean {
  const source = present(join(from, name));
  const target = present(join(to, name));
  if (source !== null && target === null) {
    renameSync(join(from, name), join(to, name));
    return true;
  }
  if (source === null && target !== null) return false;
  if (source === null && target === null && DEVICE_LOCAL_EXCLUSIONS.has(name)) return false;
  // `logs/` is shared with the native shell, which may have recreated it after the move.
  if (sharedLogs && source !== null && target !== null) return false;
  throw new Error("cutover_conflict");
}

/** Finishes the cutover of `staging` (journal present). Idempotent; throws migration_incomplete. */
function cutover(
  dataDir: string,
  staging: string,
  journal: Journal,
  afterMove?: (moves: number) => void,
): MigrationMarker {
  try {
    const backup = join(dataDir, journal.backupDir);
    if (present(backup) === null) {
      mkdirSync(backup, { mode: 0o700 });
      fsyncDirectory(dataDir);
    }
    let moves = 0;
    for (const name of journal.python) {
      if (moveOnce(dataDir, backup, name, name === "logs")) afterMove?.(++moves);
    }
    fsyncDirectory(backup);
    fsyncDirectory(dataDir);
    const native = join(staging, "native");
    for (const name of journal.native) {
      if (moveOnce(native, dataDir, name)) afterMove?.(++moves);
    }
    fsyncDirectory(dataDir);
    // The native shell keeps writing its log into `logs/`.
    if (journal.python.includes("logs")) ensurePrivateDir(join(dataDir, "logs"));
    const marker = markerOf(journal);
    replaceFileDurably(dataDir, MIGRATION_MARKER, Buffer.from(JSON.stringify(marker)));
    // Our own copy and leftovers first, the journal last: until it goes, a rerun finishes forward.
    for (const name of readdirSync(staging))
      if (name !== MIGRATION_JOURNAL) rmSync(join(staging, name), { recursive: true, force: true });
    unlinkSync(join(staging, MIGRATION_JOURNAL));
    fsyncDirectory(staging);
    rmSync(staging, { recursive: true, force: true });
    fsyncDirectory(dataDir);
    return marker;
  } catch {
    fail("migration_incomplete", "cutover_failed");
  }
}

function readJournal(staging: string): Journal {
  try {
    const path = join(staging, MIGRATION_JOURNAL);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("journal");
    return journalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    fail("migration_incomplete", "cutover_failed");
  }
}

// ---- the run -----------------------------------------------------------------------------------

/** A finished in-place import: no journal, the marker, the native inventory, no Python data. */
function finished(state: Inspection): MigrationMarker | null {
  return state.journals.length === 0 &&
    state.marker !== null &&
    state.inventory &&
    state.admission === "no_legacy_sentinel"
    ? state.marker
    : null;
}

/** Read-only, no lock: D's marker when D was already migrated in place, else null. */
export function completedMigration(dataDir: string): MigrationMarker | null {
  return finished(inspect(canonicalDataDir(dataDir)));
}

/** Read-only, no lock: D holds the journal of an interrupted cutover (finishing needs no words). */
export function interruptedMigration(dataDir: string): boolean {
  return inspect(canonicalDataDir(dataDir)).journals.length > 0;
}

/** `cashu migrate` on D. Resolves migrated / already_migrated; throws a `StartupFailureError`. */
export async function migrateInPlace(input: InPlaceInput): Promise<InPlaceResult> {
  const dataDir = canonicalDataDir(input.dataDir);
  if (!Number.isSafeInteger(input.at) || input.at < 0)
    fail("migrate_import_failed", "mapping_invalid");
  const progress = (stage: MigrateStage) => input.onProgress?.(stage);
  progress("preflight");
  // Read-only first: a finished or absent migration needs no lock and writes nothing.
  const first = inspect(dataDir);
  const done = finished(first);
  if (done !== null) return { status: "already_migrated", marker: done };
  if (first.journals.length === 0 && first.admission === "no_legacy_sentinel")
    fail("migrate_import_failed", "python_data_absent");
  const lock = holdLock(dataDir);
  try {
    const state = inspect(dataDir);
    if (state.journals.length > 1) fail("migration_incomplete", "cutover_failed");
    const pending = state.journals[0];
    if (pending !== undefined) {
      progress("cutover");
      const staging = join(dataDir, pending);
      return {
        status: "migrated",
        marker: cutover(dataDir, staging, readJournal(staging), input.afterCutoverMove),
      };
    }
    if (state.admission === "no_legacy_sentinel")
      fail("migrate_import_failed", "python_data_absent");
    if (state.admission !== "migration_required") fail("migrate_import_failed", "source_unsafe");
    if (state.inventory || state.marker !== null) fail("migrate_import_failed", "already_migrated");
    return await freshImport(dataDir, lock, input, progress);
  } finally {
    lock.release();
  }
}

async function freshImport(
  dataDir: string,
  lock: HostLock,
  input: InPlaceInput,
  progress: (stage: MigrateStage) => void,
): Promise<InPlaceResult> {
  const python = pythonEntries(dataDir);
  const keychain = input.keychain ?? defaultKeychain(dataDir);
  // A failed attempt's leftovers: staging without a journal holds only our own copies.
  for (const name of readdirSync(dataDir))
    if (name.startsWith(MIGRATION_STAGING_PREFIX))
      rmSync(join(dataDir, name), { recursive: true, force: true });
  // D has no native inventory, so a KEK in its namespace can open nothing: an orphan.
  try {
    if (await keychain.kek.present()) await keychain.kek.remove();
  } catch (error) {
    rethrowAs(error, "migrate_import_failed", "keystore_unavailable");
  }
  const time = stamp(input.at);
  const staging = join(dataDir, `${MIGRATION_STAGING_PREFIX}${time}`);
  const source = join(staging, "source");
  const native = join(staging, "native");
  const backupDir = `${PYTHON_BACKUP_PREFIX}${time}`;
  try {
    mkdirSync(staging, { mode: 0o700 });
    mkdirSync(source, { mode: 0o700 });
  } catch {
    rmSync(staging, { recursive: true, force: true });
    fail("migrate_import_failed", "staging_failed");
  }
  let journal: Journal;
  try {
    if (!lock.held) fail("migrate_import_failed", "native_host_lock_required");
    progress("copy");
    let originals: ManifestEntry[];
    try {
      originals = manifest(dataDir, python);
      copyImported(dataDir, source, originals);
    } catch (error) {
      rethrowAs(error, "migrate_import_failed", "staging_failed");
    }
    const makeKeyStore: KeyStoreFactory = (options) =>
      keychain.makeKeyStore({ ...options, scopeDir: dataDir });
    progress("import");
    let imported: OneShotResult;
    try {
      imported = await importPythonDataDir({
        sourceDir: source,
        targetDir: native,
        at: input.at,
        saveRecoveryWords: input.saveRecoveryWords,
        makeKeyStore,
      });
    } catch (error) {
      rethrowAs(error, "migrate_import_failed", "staging_failed");
    }
    progress("verify");
    try {
      const verified = await verifyPythonMigration({
        sourceDir: source,
        targetDir: native,
        at: input.at,
        makeKeyStore,
      });
      if (JSON.stringify(verified) !== JSON.stringify(imported))
        throw new MigrationError("replay_mismatch");
    } catch (error) {
      // The staged import failed its own check: an import failure (nothing was switched), so the
      // remedy is another import, not `migrate verify`, which needs a finished one.
      rethrowAs(error, "migrate_import_failed", "replay_mismatch");
    }
    try {
      // The Python app must not have written meanwhile: same entries, same bytes.
      if (
        pythonEntries(dataDir).join("\0") !== python.join("\0") ||
        manifestDigest(manifest(dataDir, python)) !== manifestDigest(originals)
      )
        throw new MigrationError("source_changed");
    } catch (error) {
      rethrowAs(error, "migrate_import_failed", "source_changed");
    }
    progress("cutover");
    const nativeEntries = readdirSync(native)
      .filter((name) => name !== "run")
      .sort(byteOrder);
    for (const name of nativeEntries)
      if (present(join(dataDir, name)) !== null) fail("migrate_import_failed", "already_migrated");
    journal = {
      format: 1,
      phase: "cutover",
      at: input.at,
      backupDir,
      python,
      native: nativeEntries,
      result: {
        profiles: imported.profiles,
        financialTables: imported.financialTables,
        financialRows: imported.financialRows,
        vaults: imported.vaults.length,
      },
    };
    // Drop the staged tree's own lock dir: D's run/ (held by us) is the one that stays.
    rmSync(join(native, "run"), { recursive: true, force: true });
    try {
      replaceFileDurably(staging, MIGRATION_JOURNAL, Buffer.from(JSON.stringify(journal)));
    } catch {
      fail("migrate_import_failed", "staging_failed");
    }
  } catch (error) {
    // Nothing was moved: drop our copy, the staged tree and the KEK this run created.
    rmSync(staging, { recursive: true, force: true });
    try {
      await keychain.kek.remove();
    } catch {
      // The orphan is removed by the next run before it imports.
    }
    throw error;
  }
  return {
    status: "migrated",
    marker: cutover(dataDir, staging, journal, input.afterCutoverMove),
  };
}

/** Reads `D/migration.json` for `cashu migrate verify` (null: D was never migrated in place). */
export function readMigrationMarker(dataDir: string): MigrationMarker | null {
  return readMarker(canonicalDataDir(dataDir));
}
