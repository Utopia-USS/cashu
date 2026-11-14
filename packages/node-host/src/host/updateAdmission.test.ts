import { chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanup, tempDir, trackDir } from "../testing/hostHarness.js";
import { acquireHostLock } from "./lock.js";
import { ensurePrivateDir, hostRunPaths } from "./paths.js";
import {
  assertHostAdmission,
  assertUpdateHandoverComplete,
  cancelUpdateAdmission,
  clearUpdateAdmissionAfterReplacement,
  commitUpdateDispatch,
  publishUpdateAdmission,
  readUpdateAdmission,
  recordUpdateHandoverComplete,
  recoverPreparedUpdateAdmission,
  waitForHostLock,
} from "./updateAdmission.js";

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
afterEach(cleanup);

it("publishes a private barrier that blocks a successor under HostLock", () => {
  const dir = trackDir(tempDir());
  ensurePrivateDir(hostRunPaths(dir).runDir);
  const marker = join(hostRunPaths(dir).runDir, "update-admission.json");
  const first = acquireHostLock(hostRunPaths(dir).lockPath);
  if (!first) throw new Error("lock");
  const barrier = publishUpdateAdmission(dir, OLD, "1.0.0", "2.0.0");
  expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(barrier);
  expect(() => publishUpdateAdmission(dir, OLD, "1.0.0", "2.0.0")).toThrow("update_barrier_exists");
  first.release();
  const successor = acquireHostLock(hostRunPaths(dir).lockPath);
  if (!successor) throw new Error("successor lock");
  expect(() => assertHostAdmission(successor, dir)).toThrow("update_pending");
  successor.release();
});

it("requires actual lock release, not a simulated socket close", async () => {
  const dir = trackDir(tempDir());
  ensurePrivateDir(hostRunPaths(dir).runDir);
  const first = acquireHostLock(hostRunPaths(dir).lockPath);
  if (!first) throw new Error("lock");
  const barrier = publishUpdateAdmission(dir, OLD, "1.0.0", "2.0.0");
  expect(await waitForHostLock(dir, barrier.id, 30)).toBeUndefined();
  first.release();
  const proof = await waitForHostLock(dir, barrier.id, 200);
  expect(proof?.held).toBe(true);
  proof?.release();
});

it("keeps an unknown drain fenced when a competing successor holds the lock", async () => {
  const dir = trackDir(tempDir());
  const barrier = publishUpdateAdmission(dir, OLD, "1.0.0", "2.0.0");
  const successor = acquireHostLock(hostRunPaths(dir).lockPath);
  if (!successor) throw new Error("lock");
  expect(await waitForHostLock(dir, barrier.id, 20)).toBeUndefined();
  expect(() => assertHostAdmission(successor, dir)).toThrow("update_pending");
  successor.release();
  const proof = await waitForHostLock(dir, barrier.id, 100);
  expect(proof?.held).toBe(true);
  proof?.release();
});

it("requires a clean completion bound to the observed host and admission", async () => {
  const dir = trackDir(tempDir());
  ensurePrivateDir(hostRunPaths(dir).runDir);
  const first = acquireHostLock(hostRunPaths(dir).lockPath);
  if (!first) throw new Error("lock");
  const barrier = publishUpdateAdmission(dir, OLD, "1.0.0", "2.0.0");
  const host = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    build: "synthetic-host",
    dataDirId: hostRunPaths(dir).dataDirId,
  };
  first.release(); // A crash releases the OS lock but writes no completion.
  const afterCrash = await waitForHostLock(dir, barrier.id, 100);
  if (!afterCrash) throw new Error("lock");
  expect(() => assertUpdateHandoverComplete(afterCrash, dir, barrier.id, host)).toThrow(
    "update_handover_unverified",
  );
  afterCrash.release();
  const second = acquireHostLock(hostRunPaths(dir).lockPath);
  if (!second) throw new Error("lock");
  recordUpdateHandoverComplete(second, dir, host);
  second.release();
  const proof = await waitForHostLock(dir, barrier.id, 100);
  if (!proof) throw new Error("lock");
  expect(() =>
    assertUpdateHandoverComplete(proof, dir, barrier.id, { ...host, build: "forged" }),
  ).toThrow("update_handover_unverified");
  expect(() => assertUpdateHandoverComplete(proof, dir, "c".repeat(64), host)).toThrow(
    "update_barrier_changed",
  );
  expect(() => assertUpdateHandoverComplete(proof, dir, barrier.id, host)).not.toThrow();
  proof.release();
});

it("binds the proof to the alternate runtime path environment", () => {
  const base = trackDir(tempDir());
  const dir = join(base, "x".repeat(120));
  const alternate = trackDir(tempDir());
  const env = { platform: "darwin" as const, tmpDir: alternate };
  const run = hostRunPaths(dir, env);
  expect(run.socketDir).toContain(alternate);
  ensurePrivateDir(run.runDir);
  const lock = acquireHostLock(run.lockPath);
  if (!lock) throw new Error("lock");
  publishUpdateAdmission(dir, OLD, "1.0.0", "2.0.0");
  expect(() => assertHostAdmission(lock, dir, env)).toThrow("update_pending");
  const host = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    build: "alternate-host",
    dataDirId: run.dataDirId,
  };
  recordUpdateHandoverComplete(lock, dir, host, env);
  lock.release();
});

it("keeps old or wrong-version copies fenced and clears only an expected replacement", () => {
  const dir = trackDir(tempDir());
  const barrier = publishUpdateAdmission(dir, OLD, "1.0.0", "2.0.0");
  const lock = acquireHostLock(hostRunPaths(dir).lockPath);
  if (!lock) throw new Error("lock");
  expect(() => clearUpdateAdmissionAfterReplacement(lock, dir, OLD, "2.0.0")).toThrow(
    "update_replacement_unverified",
  );
  expect(() => clearUpdateAdmissionAfterReplacement(lock, dir, NEW, "1.0.0")).toThrow(
    "update_replacement_unverified",
  );
  expect(() => cancelUpdateAdmission(lock, dir, "c".repeat(64))).toThrow("update_barrier_changed");
  expect(() => assertHostAdmission(lock, dir)).toThrow("update_pending");
  expect(() => clearUpdateAdmissionAfterReplacement(lock, dir, NEW, barrier.targetVersion)).toThrow(
    "update_replacement_unverified",
  );
  commitUpdateDispatch(lock, dir, barrier.id);
  clearUpdateAdmissionAfterReplacement(lock, dir, NEW, barrier.targetVersion);
  expect(() => assertHostAdmission(lock, dir)).not.toThrow();
  lock.release();
});

it("allows definitive pre-dispatch cancellation only with the exact held lock and id", () => {
  const dir = trackDir(tempDir());
  const barrier = publishUpdateAdmission(dir, OLD, "1.0.0", "2.0.0");
  const lock = acquireHostLock(hostRunPaths(dir).lockPath);
  if (!lock) throw new Error("lock");
  cancelUpdateAdmission(lock, dir, barrier.id);
  expect(() => assertHostAdmission(lock, dir)).not.toThrow();
  lock.release();
  expect(() => cancelUpdateAdmission(lock, dir, barrier.id)).toThrow("update_lock_required");
});

it("persists dispatch commitment and refuses old-bundle recovery", () => {
  const dir = trackDir(tempDir());
  const barrier = publishUpdateAdmission(dir, OLD, "1.0.0", "2.0.0");
  const lock = acquireHostLock(hostRunPaths(dir).lockPath);
  if (!lock) throw new Error("lock");
  expect(readUpdateAdmission(dir)?.phase).toBe("prepared");
  commitUpdateDispatch(lock, dir, barrier.id);
  expect(readUpdateAdmission(dir)?.phase).toBe("dispatch_committed");
  expect(() => commitUpdateDispatch(lock, dir, barrier.id)).toThrow("update_dispatch_unverified");
  expect(() => cancelUpdateAdmission(lock, dir, barrier.id)).toThrow("update_dispatch_unverified");
  expect(() => recoverPreparedUpdateAdmission(lock, dir, OLD, "1.0.0")).toThrow(
    "update_dispatch_unverified",
  );
  expect(() => clearUpdateAdmissionAfterReplacement(lock, dir, NEW, "2.0.0")).not.toThrow();
  lock.release();
});

it("recovers only an abandoned prepared intent for the identical old bundle", () => {
  const dir = trackDir(tempDir());
  publishUpdateAdmission(dir, OLD, "1.0.0", "2.0.0");
  const lock = acquireHostLock(hostRunPaths(dir).lockPath);
  if (!lock) throw new Error("lock");
  expect(() => recoverPreparedUpdateAdmission(lock, dir, NEW, "1.0.0")).toThrow(
    "update_dispatch_unverified",
  );
  expect(() => recoverPreparedUpdateAdmission(lock, dir, OLD, "2.0.0")).toThrow(
    "update_dispatch_unverified",
  );
  recoverPreparedUpdateAdmission(lock, dir, OLD, "1.0.0");
  expect(readUpdateAdmission(dir)).toBeUndefined();
  lock.release();
});

it("fails closed on malformed, symlinked or weakened barriers", () => {
  const dir = trackDir(tempDir());
  const barrier = publishUpdateAdmission(dir, OLD, "1.0.0", "2.0.0");
  const marker = join(hostRunPaths(dir).runDir, "update-admission.json");
  const lock = acquireHostLock(hostRunPaths(dir).lockPath);
  if (!lock) throw new Error("lock");
  writeFileSync(marker, "{}");
  expect(() => assertHostAdmission(lock, dir)).toThrow("update_barrier_invalid");
  writeFileSync(marker, JSON.stringify(barrier));
  chmodSync(marker, 0o644);
  expect(() => assertHostAdmission(lock, dir)).toThrow("update_barrier_invalid");
  lock.release();
  const other = trackDir(tempDir());
  const link = join(hostRunPaths(other).runDir, "update-admission.json");
  publishUpdateAdmission(other, OLD, "1.0.0", "2.0.0");
  rmSync(link);
  symlinkSync(marker, link);
  const next = acquireHostLock(hostRunPaths(other).lockPath);
  if (!next) throw new Error("lock");
  expect(() => assertHostAdmission(next, other)).toThrow("update_barrier_invalid");
  next.release();
});

it("fails closed on barrier and completion records with a wrong field", async () => {
  const dir = trackDir(tempDir());
  const barrier = publishUpdateAdmission(dir, OLD, "1.0.0", "2.0.0");
  const run = hostRunPaths(dir);
  const marker = join(run.runDir, "update-admission.json");
  for (const record of [
    { ...barrier, extra: true },
    { ...barrier, targetVersion: barrier.fromVersion },
    { ...barrier, phase: "done" },
  ]) {
    writeFileSync(marker, JSON.stringify(record));
    expect(() => readUpdateAdmission(dir)).toThrow("update_barrier_invalid");
  }
  writeFileSync(marker, JSON.stringify(barrier));
  const host = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    build: "synthetic-host",
    dataDirId: run.dataDirId,
  };
  const first = acquireHostLock(run.lockPath);
  if (!first) throw new Error("lock");
  recordUpdateHandoverComplete(first, dir, host);
  first.release();
  const complete = join(run.runDir, "update-handover-complete.json");
  const recorded = JSON.parse(readFileSync(complete, "utf8"));
  const proof = await waitForHostLock(dir, barrier.id, 100);
  if (!proof) throw new Error("lock");
  for (const record of [
    { ...recorded, extra: true },
    { ...recorded, pid: String(host.pid) },
  ]) {
    writeFileSync(complete, JSON.stringify(record));
    expect(() => assertUpdateHandoverComplete(proof, dir, barrier.id, host)).toThrow(
      "update_handover_unverified",
    );
  }
  writeFileSync(complete, JSON.stringify(recorded));
  expect(() => assertUpdateHandoverComplete(proof, dir, barrier.id, host)).not.toThrow();
  proof.release();
});
