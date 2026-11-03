// A per-data-dir update barrier. The updater publishes it before asking the current host to stop.
// Every successor checks it while holding HostLock, before creating a socket or opening a vault.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { acquireHostLock, type HostLock } from "./lock.js";
import { ensurePrivateDir, type HostPathEnv, hostRunPaths } from "./paths.js";

const FILE = "update-admission.json";
const COMPLETE_FILE = "update-handover-complete.json";
const MAX_BYTES = 512;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface UpdateAdmission {
  readonly schema: 1;
  readonly id: string;
  readonly phase: "prepared" | "dispatch_committed";
  readonly fromFingerprint: string;
  readonly fromVersion: string;
  readonly targetVersion: string;
}

export interface UpdateHandoverHost {
  readonly pid: number;
  readonly startedAt: string;
  readonly build: string;
  readonly dataDirId: string;
}

interface UpdateHandoverComplete extends UpdateHandoverHost {
  readonly schema: 1;
  readonly admissionId: string;
}

type UpdateAdmissionCode =
  | "update_pending"
  | "update_barrier_invalid"
  | "update_barrier_exists"
  | "update_barrier_changed"
  | "update_lock_required"
  | "update_replacement_unverified"
  | "update_dispatch_unverified"
  | "update_handover_unverified";

export class UpdateAdmissionError extends Error {
  readonly code: UpdateAdmissionCode;
  constructor(code: UpdateAdmissionCode) {
    super(code);
    this.code = code;
    this.name = "UpdateAdmissionError";
  }
}

function paths(dataDir: string, pathEnv?: HostPathEnv) {
  const run = hostRunPaths(dataDir, pathEnv);
  return { run, marker: join(run.runDir, FILE), complete: join(run.runDir, COMPLETE_FILE) };
}

function assertLock(lock: HostLock, dataDir: string, pathEnv?: HostPathEnv): void {
  if (!lock.held || lock.path !== paths(dataDir, pathEnv).run.lockPath)
    throw new UpdateAdmissionError("update_lock_required");
}

function read(dataDir: string, pathEnv?: HostPathEnv): UpdateAdmission | undefined {
  const { marker } = paths(dataDir, pathEnv);
  let fd: number;
  try {
    fd = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new UpdateAdmissionError("update_barrier_invalid");
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > MAX_BYTES ||
      stat.size === 0 ||
      (stat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new Error("invalid_file");
    const value: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("invalid_shape");
    const v = value as Record<string, unknown>;
    if (
      Object.keys(v).sort().join(",") !==
        "fromFingerprint,fromVersion,id,phase,schema,targetVersion" ||
      v.schema !== 1 ||
      (v.phase !== "prepared" && v.phase !== "dispatch_committed") ||
      typeof v.id !== "string" ||
      !FINGERPRINT.test(v.id) ||
      typeof v.fromFingerprint !== "string" ||
      !FINGERPRINT.test(v.fromFingerprint) ||
      typeof v.fromVersion !== "string" ||
      v.fromVersion.length > 64 ||
      !VERSION.test(v.fromVersion) ||
      typeof v.targetVersion !== "string" ||
      v.targetVersion.length > 64 ||
      !VERSION.test(v.targetVersion) ||
      v.targetVersion === v.fromVersion
    )
      throw new Error("invalid_shape");
    return v as unknown as UpdateAdmission;
  } catch {
    throw new UpdateAdmissionError("update_barrier_invalid");
  } finally {
    closeSync(fd);
  }
}

/** Read-only startup preflight. Recovery must reread while holding HostLock before clearing. */
export function readUpdateAdmission(
  dataDir: string,
  pathEnv?: HostPathEnv,
): UpdateAdmission | undefined {
  return read(dataDir, pathEnv);
}

function syncDir(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Publish before requesting admin.handover. An existing or malformed barrier is never replaced. */
export function publishUpdateAdmission(
  dataDir: string,
  fromFingerprint: string,
  fromVersion: string,
  targetVersion: string,
  pathEnv?: HostPathEnv,
): UpdateAdmission {
  if (
    !FINGERPRINT.test(fromFingerprint) ||
    fromVersion.length > 64 ||
    !VERSION.test(fromVersion) ||
    targetVersion.length > 64 ||
    !VERSION.test(targetVersion) ||
    fromVersion === targetVersion
  )
    throw new UpdateAdmissionError("update_barrier_invalid");
  const { run, marker } = paths(dataDir, pathEnv);
  ensurePrivateDir(run.runDir);
  if (read(dataDir, pathEnv) !== undefined) throw new UpdateAdmissionError("update_barrier_exists");
  const admission: UpdateAdmission = {
    schema: 1,
    id: randomBytes(32).toString("hex"),
    phase: "prepared",
    fromFingerprint,
    fromVersion,
    targetVersion,
  };
  const temp = join(run.runDir, `.update-admission-${admission.id}.tmp`);
  let fd: number;
  try {
    fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(admission));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // link creates the final name atomically without replacing a concurrent barrier.
    linkSync(temp, marker);
    syncDir(run.runDir);
    return admission;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new UpdateAdmissionError("update_barrier_exists");
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Call immediately after taking HostLock, before a host publishes any socket or opens data. */
export function assertHostAdmission(lock: HostLock, dataDir: string, pathEnv?: HostPathEnv): void {
  assertLock(lock, dataDir, pathEnv);
  if (read(dataDir, pathEnv) !== undefined) throw new UpdateAdmissionError("update_pending");
}

/** A socket close is only a hint. Acquiring this lock proves all prior host writers have stopped. */
export async function waitForHostLock(
  dataDir: string,
  admissionId: string,
  timeoutMs: number,
  pathEnv?: HostPathEnv,
): Promise<HostLock | undefined> {
  if (
    !FINGERPRINT.test(admissionId) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > 30_000
  )
    throw new UpdateAdmissionError("update_barrier_invalid");
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const barrier = read(dataDir, pathEnv);
    if (barrier?.id !== admissionId) throw new UpdateAdmissionError("update_barrier_changed");
    const lock = acquireHostLock(paths(dataDir, pathEnv).run.lockPath);
    if (lock !== undefined) {
      try {
        if (read(dataDir, pathEnv)?.id !== admissionId)
          throw new UpdateAdmissionError("update_barrier_changed");
        return lock;
      } catch (error) {
        lock.release();
        throw error;
      }
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
}

/**
 * The host writes this only after every writer and sync job has drained and `record.clean()` has
 * completed, while it still holds HostLock. Socket close and OS lock release alone are insufficient.
 */
export function recordUpdateHandoverComplete(
  lock: HostLock,
  dataDir: string,
  host: UpdateHandoverHost,
  pathEnv?: HostPathEnv,
): void {
  assertLock(lock, dataDir, pathEnv);
  const barrier = read(dataDir, pathEnv);
  const { run, complete } = paths(dataDir, pathEnv);
  if (
    barrier === undefined ||
    host.pid !== process.pid ||
    !Number.isSafeInteger(host.pid) ||
    host.pid <= 0 ||
    host.dataDirId !== run.dataDirId ||
    !FINGERPRINT.test(host.dataDirId) ||
    typeof host.build !== "string" ||
    host.build.length === 0 ||
    host.build.length > 128 ||
    typeof host.startedAt !== "string" ||
    !Number.isFinite(Date.parse(host.startedAt))
  )
    throw new UpdateAdmissionError("update_handover_unverified");
  const value: UpdateHandoverComplete = { schema: 1, admissionId: barrier.id, ...host };
  const temp = join(run.runDir, `.update-handover-${barrier.id}.tmp`);
  try {
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify(value));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const current = read(dataDir, pathEnv);
    if (current?.id !== barrier.id) throw new UpdateAdmissionError("update_barrier_changed");
    // Only the HostLock holder writes this proof. A stale proof has a different admission id.
    renameSync(temp, complete);
    syncDir(run.runDir);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Call under the reacquired HostLock, comparing the host observed before admin.handover. */
export function assertUpdateHandoverComplete(
  lock: HostLock,
  dataDir: string,
  admissionId: string,
  expected: UpdateHandoverHost,
  pathEnv?: HostPathEnv,
): void {
  assertLock(lock, dataDir, pathEnv);
  if (read(dataDir, pathEnv)?.id !== admissionId)
    throw new UpdateAdmissionError("update_barrier_changed");
  const { run, complete } = paths(dataDir, pathEnv);
  try {
    const fd = openSync(complete, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let value: unknown;
    try {
      const stat = fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.size === 0 ||
        stat.size > MAX_BYTES ||
        (stat.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      )
        throw new Error("invalid_file");
      value = JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("invalid_shape");
    const v = value as Record<string, unknown>;
    if (
      Object.keys(v).sort().join(",") !== "admissionId,build,dataDirId,pid,schema,startedAt" ||
      v.schema !== 1 ||
      v.admissionId !== admissionId ||
      v.pid !== expected.pid ||
      v.startedAt !== expected.startedAt ||
      v.build !== expected.build ||
      v.dataDirId !== expected.dataDirId ||
      v.dataDirId !== run.dataDirId
    )
      throw new Error("mismatch");
  } catch {
    throw new UpdateAdmissionError("update_handover_unverified");
  }
}

/**
 * Main calls this only after its installed release authority verified the replacement's signing,
 * location and data dir. The lock and exact changed fingerprint/version prevent an old app restart.
 */
export function clearUpdateAdmissionAfterReplacement(
  lock: HostLock,
  dataDir: string,
  currentFingerprint: string,
  currentVersion: string,
  pathEnv?: HostPathEnv,
): void {
  assertLock(lock, dataDir, pathEnv);
  const barrier = read(dataDir, pathEnv);
  if (!barrier) return;
  if (
    barrier.phase !== "dispatch_committed" ||
    !FINGERPRINT.test(currentFingerprint) ||
    currentFingerprint === barrier.fromFingerprint ||
    currentVersion !== barrier.targetVersion
  )
    throw new UpdateAdmissionError("update_replacement_unverified");
  const { run, marker } = paths(dataDir, pathEnv);
  const stat = lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new UpdateAdmissionError("update_barrier_invalid");
  unlinkSync(marker);
  syncDir(run.runDir);
}

/**
 * A ready handover's main-owned cancel handle may call this only before installer dispatch, after
 * it has proven no install was started. Unknown installer outcome must leave the barrier in place.
 */
export function cancelUpdateAdmission(
  lock: HostLock,
  dataDir: string,
  admissionId: string,
  pathEnv?: HostPathEnv,
): void {
  assertLock(lock, dataDir, pathEnv);
  const barrier = read(dataDir, pathEnv);
  if (barrier?.id !== admissionId) throw new UpdateAdmissionError("update_barrier_changed");
  if (barrier.phase !== "prepared") throw new UpdateAdmissionError("update_dispatch_unverified");
  const { run, marker } = paths(dataDir, pathEnv);
  unlinkSync(marker);
  syncDir(run.runDir);
}

/** Commit the no-return installer boundary durably while main still owns HostLock. */
export function commitUpdateDispatch(
  lock: HostLock,
  dataDir: string,
  admissionId: string,
  pathEnv?: HostPathEnv,
): void {
  assertLock(lock, dataDir, pathEnv);
  const barrier = read(dataDir, pathEnv);
  if (barrier?.id !== admissionId) throw new UpdateAdmissionError("update_barrier_changed");
  if (barrier.phase !== "prepared") throw new UpdateAdmissionError("update_dispatch_unverified");
  const { run, marker } = paths(dataDir, pathEnv);
  const temp = join(run.runDir, `.update-dispatch-${barrier.id}.tmp`);
  try {
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, JSON.stringify({ ...barrier, phase: "dispatch_committed" }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (read(dataDir, pathEnv)?.id !== admissionId)
      throw new UpdateAdmissionError("update_barrier_changed");
    renameSync(temp, marker);
    syncDir(run.runDir);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * New main may recover a prepared intent after its single-instance lock proves the old main died,
 * its signed release gate passes, and it acquires HostLock. A committed outcome remains fenced.
 */
export function recoverPreparedUpdateAdmission(
  lock: HostLock,
  dataDir: string,
  currentFingerprint: string,
  currentVersion: string,
  pathEnv?: HostPathEnv,
): void {
  assertLock(lock, dataDir, pathEnv);
  const barrier = read(dataDir, pathEnv);
  if (
    barrier?.phase !== "prepared" ||
    barrier.fromFingerprint !== currentFingerprint ||
    barrier.fromVersion !== currentVersion
  )
    throw new UpdateAdmissionError("update_dispatch_unverified");
  cancelUpdateAdmission(lock, dataDir, barrier.id, pathEnv);
}
