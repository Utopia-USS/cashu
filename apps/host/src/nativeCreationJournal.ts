import { randomBytes } from "node:crypto";
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
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type HostLock, hostRunPaths } from "@cashu/node-host";
import { readExistingNativeInventory } from "./nativeInventory.js";

const ID = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const STAGES = ["recorded", "keys", "artifacts", "history", "admission", "publishing"] as const;
const MAX_BYTES = 64 * 1024;
const MAX_COMPLETED = 64;

export type CreationStage = (typeof STAGES)[number];

export interface PendingCreation {
  readonly operationId: string;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly inputHash: string;
  readonly stage: CreationStage;
}

export interface CompletedCreation {
  readonly sequence: number;
  readonly operationId: string;
  readonly vaultId: string;
  readonly deviceId: string;
  readonly inputHash: string;
  readonly profileSlug: string;
  readonly eventCount: number;
  readonly pinEid: string;
  /** This anchor is metadata. The caller must authenticate replay before serving ready. */
  readonly effectHash: string;
}

interface Journal {
  readonly format: 1;
  readonly nextSequence: number;
  readonly pending: PendingCreation | null;
  readonly completed: readonly CompletedCreation[];
}

export interface NativeCreationJournalSnapshot extends Journal {}

const EMPTY: Journal = { format: 1, nextSequence: 1, pending: null, completed: [] };

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function validPending(value: unknown): value is PendingCreation {
  return (
    exact(value, ["operationId", "vaultId", "deviceId", "inputHash", "stage"]) &&
    typeof value.operationId === "string" &&
    ID.test(value.operationId) &&
    typeof value.vaultId === "string" &&
    ID.test(value.vaultId) &&
    typeof value.deviceId === "string" &&
    ID.test(value.deviceId) &&
    typeof value.inputHash === "string" &&
    HASH.test(value.inputHash) &&
    STAGES.includes(value.stage as CreationStage)
  );
}

function validCompleted(value: unknown): value is CompletedCreation {
  return (
    exact(value, [
      "sequence",
      "operationId",
      "vaultId",
      "deviceId",
      "inputHash",
      "profileSlug",
      "eventCount",
      "pinEid",
      "effectHash",
    ]) &&
    Number.isSafeInteger(value.sequence) &&
    (value.sequence as number) > 0 &&
    typeof value.operationId === "string" &&
    ID.test(value.operationId) &&
    typeof value.vaultId === "string" &&
    ID.test(value.vaultId) &&
    typeof value.deviceId === "string" &&
    ID.test(value.deviceId) &&
    typeof value.inputHash === "string" &&
    HASH.test(value.inputHash) &&
    typeof value.profileSlug === "string" &&
    SLUG.test(value.profileSlug) &&
    Number.isSafeInteger(value.eventCount) &&
    (value.eventCount as number) >= 1 &&
    (value.eventCount as number) <= 5 &&
    typeof value.pinEid === "string" &&
    /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value.pinEid) &&
    typeof value.effectHash === "string" &&
    HASH.test(value.effectHash)
  );
}

function decode(bytes: Buffer): Journal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("native_creation_journal_invalid");
  }
  if (
    !exact(parsed, ["format", "nextSequence", "pending", "completed"]) ||
    parsed.format !== 1 ||
    !Number.isSafeInteger(parsed.nextSequence) ||
    (parsed.nextSequence as number) < 1 ||
    (parsed.pending !== null && !validPending(parsed.pending)) ||
    !Array.isArray(parsed.completed) ||
    parsed.completed.length > MAX_COMPLETED ||
    !parsed.completed.every(validCompleted)
  )
    throw new Error("native_creation_journal_invalid");
  const completed = parsed.completed as CompletedCreation[];
  const ids = new Set(completed.map((item) => item.operationId));
  if (ids.size !== completed.length || (parsed.pending && ids.has(parsed.pending.operationId)))
    throw new Error("native_creation_journal_invalid");
  if (completed.some((item, index) => item.sequence !== index + 1))
    throw new Error("native_creation_journal_invalid");
  if (parsed.nextSequence !== completed.length + 1)
    throw new Error("native_creation_journal_invalid");
  return {
    format: 1,
    nextSequence: parsed.nextSequence as number,
    pending: parsed.pending as PendingCreation | null,
    completed,
  };
}

function privateDir(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (stat.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new Error("native_creation_path_invalid");
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readJournal(path: string): Journal {
  if (!pathEntryExists(path)) return EMPTY;
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  )
    throw new Error("native_creation_path_invalid");
  if (before.size > MAX_BYTES) throw new Error("native_creation_journal_invalid");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size ||
      !opened.isFile() ||
      opened.nlink !== 1
    )
      throw new Error("native_creation_path_invalid");
    const bytes = readFileSync(fd);
    if (bytes.length !== opened.size) throw new Error("native_creation_journal_invalid");
    return decode(bytes);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  privateDir(path);
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isDirectory() ||
      (stat.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new Error("native_creation_path_invalid");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeJournal(path: string, state: Journal): void {
  const dir = dirname(path);
  const bytes = Buffer.from(JSON.stringify(state));
  if (bytes.length > MAX_BYTES) throw new Error("native_creation_journal_full");
  const temp = join(dir, `.creation-${randomBytes(16).toString("hex")}.tmp`);
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  fsyncDirectory(dir);
}

/** Read-only preflight. Startup repeats it after acquiring HostLock. */
export function readNativeCreationJournal(dataDir: string): NativeCreationJournalSnapshot {
  if (resolve(dataDir) !== dataDir) throw new Error("native_creation_path_invalid");
  try {
    if (realpathSync(dataDir) !== dataDir) throw new Error("native_creation_path_invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
    throw error;
  }
  privateDir(dataDir);
  const native = join(dataDir, "native");
  if (!pathEntryExists(native)) return EMPTY;
  privateDir(native);
  const version = join(native, "v1");
  if (!pathEntryExists(version)) return EMPTY;
  privateDir(version);
  const entries = readdirSync(version);
  const leftovers = entries.filter((entry) =>
    /^\.(?:creation|inventory)-[0-9a-f]{32}\.tmp$/.test(entry),
  );
  const allowed = new Set(["creation.json", "inventory.json", ...leftovers]);
  if (entries.some((entry) => !allowed.has(entry))) throw new Error("native_creation_ambiguous");
  const journal = readJournal(join(version, "creation.json"));
  if (leftovers.length > 0 && !journal.pending) throw new Error("native_creation_ambiguous");
  return journal;
}

/** Classify setup without creating files or equating a locator with authenticated authority. */
export function classifyNativeCreationStartup(dataDir: string): "setup" | "pending" | "ready" {
  const journal = readNativeCreationJournal(dataDir);
  const inventory = join(dataDir, "native", "v1", "inventory.json");
  if (pathEntryExists(inventory)) {
    try {
      readExistingNativeInventory(dataDir);
      return "ready";
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "native_setup_required") throw error;
    }
  }
  const stores = join(dataDir, "stores");
  if (pathEntryExists(stores)) {
    privateDir(stores);
    const allowed = new Set([
      "device.db",
      "device.db-wal",
      "device.db-shm",
      "device.db-journal",
      "vaults",
    ]);
    if (readdirSync(stores).some((entry) => !allowed.has(entry)))
      throw new Error("native_creation_ambiguous");
    const syntheticVaults = join(stores, "vaults");
    if (pathEntryExists(syntheticVaults)) {
      privateDir(syntheticVaults);
      if (readdirSync(syntheticVaults).length > 0) throw new Error("native_creation_ambiguous");
    }
  }
  const secrets = join(dataDir, "vault-secrets");
  if (pathEntryExists(secrets)) {
    privateDir(secrets);
    const children = readdirSync(secrets);
    if (children.some((entry) => entry !== "v1")) throw new Error("native_creation_ambiguous");
    const version = join(secrets, "v1");
    if (pathEntryExists(version)) {
      privateDir(version);
      if (readdirSync(version).length > 0 && !journal.pending)
        throw new Error("native_creation_ambiguous");
    }
  }
  if (journal.pending) return "pending";
  if (journal.completed.length > 0) throw new Error("native_creation_ambiguous");
  const vaults = join(dataDir, "vaults");
  if (pathEntryExists(vaults)) {
    privateDir(vaults);
    if (readdirSync(vaults).length > 0) throw new Error("native_creation_ambiguous");
  }
  return "setup";
}

/** Single writer creation metadata under the real host lock. This journal grants no vault authority. */
export class NativeCreationJournal {
  readonly #dataDir: string;
  readonly #lock: HostLock;
  readonly #path: string;

  constructor(dataDir: string, lock: HostLock) {
    if (resolve(dataDir) !== dataDir || realpathSync(dataDir) !== dataDir)
      throw new Error("native_creation_path_invalid");
    if (!lock.held || lock.path !== hostRunPaths(dataDir).lockPath)
      throw new Error("native_host_lock_required");
    privateDir(dataDir);
    this.#dataDir = dataDir;
    this.#lock = lock;
    this.#path = join(dataDir, "native", "v1", "creation.json");
  }

  #assertLock(): void {
    if (!this.#lock.held || this.#lock.path !== hostRunPaths(this.#dataDir).lockPath)
      throw new Error("native_host_lock_required");
  }

  #read(): Journal {
    this.#assertLock();
    return readNativeCreationJournal(this.#dataDir);
  }

  #prepareDirectories(): void {
    for (const path of [join(this.#dataDir, "native"), join(this.#dataDir, "native", "v1")]) {
      if (!pathEntryExists(path)) {
        mkdirSync(path, { mode: 0o700 });
        fsyncDirectory(dirname(path));
      }
      privateDir(path);
    }
  }

  /** Read-only even when the journal does not yet exist. */
  snapshot(): Journal {
    return this.#read();
  }

  /** The KeyStore calls this synchronously at every awaited mutation boundary. */
  assertPending(operationId: string, vaultId: string, deviceId: string): void {
    const pending = this.#read().pending;
    if (
      pending?.operationId !== operationId ||
      pending.vaultId !== vaultId ||
      pending.deviceId !== deviceId
    )
      throw new Error("native_creation_pending_mismatch");
  }

  begin(record: Omit<PendingCreation, "stage">): PendingCreation {
    this.#assertLock();
    const state = this.#read();
    if (state.pending || state.completed.some((item) => item.operationId === record.operationId))
      throw new Error("native_creation_pending_exists");
    if (state.completed.length >= MAX_COMPLETED) throw new Error("native_creation_journal_full");
    const pending: PendingCreation = { ...record, stage: "recorded" };
    if (!validPending(pending)) throw new Error("native_creation_journal_invalid");
    this.#prepareDirectories();
    writeJournal(this.#path, { ...state, pending });
    return pending;
  }

  advance(operationId: string, next: CreationStage): PendingCreation {
    const state = this.#read();
    const pending = state.pending;
    if (pending?.operationId !== operationId || !STAGES.includes(next))
      throw new Error("native_creation_pending_mismatch");
    if (STAGES.indexOf(next) <= STAGES.indexOf(pending.stage))
      throw new Error("native_creation_phase_regression");
    const updated = { ...pending, stage: next };
    writeJournal(this.#path, { ...state, pending: updated });
    return updated;
  }

  complete(
    operationId: string,
    profileSlug: string,
    eventCount: number,
    pinEid: string,
    effectHash: string,
  ): CompletedCreation {
    const state = this.#read();
    const pending = state.pending;
    if (pending?.operationId !== operationId || pending.stage !== "publishing")
      throw new Error("native_creation_pending_mismatch");
    const { stage: _stage, ...base } = pending;
    const anchor: CompletedCreation = {
      ...base,
      sequence: state.nextSequence,
      profileSlug,
      eventCount,
      pinEid,
      effectHash,
    };
    if (!validCompleted(anchor)) throw new Error("native_creation_journal_invalid");
    if (state.completed.length >= MAX_COMPLETED) throw new Error("native_creation_journal_full");
    writeJournal(this.#path, {
      format: 1,
      nextSequence: state.nextSequence + 1,
      pending: null,
      completed: [...state.completed, anchor],
    });
    return anchor;
  }
}
