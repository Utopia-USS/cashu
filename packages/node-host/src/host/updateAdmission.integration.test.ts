import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanup, tempDir, trackDir } from "../testing/hostHarness.js";
import { readDiscovery } from "./files.js";
import { hostRunPaths } from "./paths.js";
import { startHost } from "./server.js";
import {
  assertUpdateHandoverComplete,
  publishUpdateAdmission,
  recordUpdateHandoverComplete,
  recoverPreparedUpdateAdmission,
  waitForHostLock,
} from "./updateAdmission.js";

const OLD = "a".repeat(64);
afterEach(cleanup);

it("fences a real successor before socket publication and proves a bound completed handover", async () => {
  const base = trackDir(tempDir());
  const dataDir = join(base, `long-${"x".repeat(120)}`);
  const runtime = trackDir(mkdtempSync(join(realpathSync(tmpdir()), "ch-")));
  const pathEnv = { platform: "darwin" as const, tmpDir: runtime };
  const paths = hostRunPaths(dataDir, pathEnv);
  expect(paths.socketDir).toContain(runtime);
  const host = await startHost({ dataDir, pathEnv, build: "first", onSession() {} });
  expect(readDiscovery(paths.discoveryPath)?.pid).toBe(process.pid);
  const barrier = publishUpdateAdmission(dataDir, OLD, "1.0.0", "2.0.0", pathEnv);
  const expected = {
    pid: process.pid,
    startedAt: host.startedAt.toISOString(),
    build: "first",
    dataDirId: paths.dataDirId,
  };
  expect(await waitForHostLock(dataDir, barrier.id, 20, pathEnv)).toBeUndefined();
  host.beginStop();
  recordUpdateHandoverComplete(host.lock, dataDir, expected, pathEnv);
  await host.close();
  const proof = await waitForHostLock(dataDir, barrier.id, 100, pathEnv);
  if (!proof) throw new Error("missing lock proof");
  expect(() =>
    assertUpdateHandoverComplete(proof, dataDir, barrier.id, expected, pathEnv),
  ).not.toThrow();
  proof.release();
  await expect(startHost({ dataDir, pathEnv, build: "successor", onSession() {} })).rejects.toThrow(
    "update_pending",
  );
  expect(readDiscovery(paths.discoveryPath)).toBeUndefined();
  const recovery = await waitForHostLock(dataDir, barrier.id, 100, pathEnv);
  if (!recovery) throw new Error("missing recovery lock");
  assertUpdateHandoverComplete(recovery, dataDir, barrier.id, expected, pathEnv);
  recoverPreparedUpdateAdmission(recovery, dataDir, OLD, "1.0.0", pathEnv);
  recovery.release();
  const successor = await startHost({ dataDir, pathEnv, build: "successor", onSession() {} });
  expect(readDiscovery(paths.discoveryPath)?.build).toBe("successor");
  await successor.close();
});

it("refuses a real host close without its bound completion proof", async () => {
  const dataDir = trackDir(tempDir());
  const paths = hostRunPaths(dataDir);
  const host = await startHost({ dataDir, build: "first", onSession() {} });
  const barrier = publishUpdateAdmission(dataDir, OLD, "1.0.0", "2.0.0");
  const expected = {
    pid: process.pid,
    startedAt: host.startedAt.toISOString(),
    build: "first",
    dataDirId: paths.dataDirId,
  };
  // The socket closes and HostLock releases, as they would if the process died mid-drain.
  await host.close();
  const proof = await waitForHostLock(dataDir, barrier.id, 100);
  if (!proof) throw new Error("missing lock proof");
  expect(() => assertUpdateHandoverComplete(proof, dataDir, barrier.id, expected)).toThrow(
    "update_handover_unverified",
  );
  proof.release();
});
