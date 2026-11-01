// Kill recovery THROUGH the host (S56c acceptance, S31a spec 6): a spawned host process SIGKILLs itself
// when its sync service reaches a crash point (after the intents are stored, after the writes, after
// the ack, between the per-vault writes / clears of a two-vault plan); the next host started on the
// data dir recovers at its wake-up: every event once in the log, nothing pending, no intent left. A
// synthetic Python data dir and a fake `cashu` CLI (testing/lab.ts). Synthetic data only.
import { adminStatusResultSchema, type SyncStatus } from "@cashu/host-protocol";
import { connectHost } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { crypto } from "@cashu/sync";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, spawnHost } from "../testing/harness.js";
import { labFileKeyStore } from "./keys/labFile.js";
import { labGate } from "./keys/labGate.js";
import { loadVaultKeys } from "./keys/vaultKeys.js";
import { PythonReader } from "./python/reader.js";
import { closeLabs, GID_A, GID_B, type Lab, lab } from "./testing/lab.js";
import { openVault } from "./vault.js";

const sodium = await crypto.loadNodeSodium();

afterEach(() => {
  closeLabs();
  cleanup();
});

async function stopHost(dataDir: string): Promise<void> {
  const admin = await connectHost({ dataDir, role: "admin", build: "t" });
  const closed = new Promise<void>((resolve) => admin.onClose(resolve));
  await admin.call("admin.stop");
  await closed;
}

async function until(check: () => boolean | Promise<boolean>, ms = 4_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Pending may already be zero at the crash: wait for the recovery turn, including intent clears. */
async function recovered(dataDir: string): Promise<SyncStatus> {
  const admin = await connectHost({ dataDir, role: "admin", build: "t" });
  let sync: SyncStatus | undefined;
  try {
    await until(async () => {
      sync = adminStatusResultSchema.parse(await admin.call("admin.status")).sync;
      return (
        sync !== undefined &&
        sync.state === "idle" &&
        sync.lastRunAt !== undefined &&
        sync.pending === 0 &&
        sync.vaults.every((v) => !v.intentOpen)
      );
    });
    if (sync === undefined) throw new Error("missing sync status");
    return sync;
  } finally {
    admin.close();
  }
}

/** Per vault (after the host stopped): events, distinct eids, an open intent. */
async function vaultLogs(l: Lab) {
  const reader = new PythonReader(l.dir);
  const store = labFileKeyStore(l.keys);
  const out: { events: number; distinct: number; intentOpen: boolean }[] = [];
  for (const [ordinal, linked] of reader.vaults().entries()) {
    const keys = await loadVaultKeys(store, sodium, linked.vaultId);
    if (keys === undefined) throw new Error("keys");
    const v = await openVault({
      ordinal,
      profileId: linked.profileId,
      stateRoot: l.stateRoot,
      remotes: [],
      keys,
      sodium,
      gate: await labGate(store, sodium, keys.ring, keys.identity),
      openDb: (path) => openNodeSqlite(path),
    });
    const eids = v.store.read<{ eid: string }>("SELECT eid FROM event_log").map((r) => r.eid);
    out.push({
      events: eids.length,
      distinct: new Set(eids).size,
      intentOpen: v.state.intent() !== undefined,
    });
    await v.close();
  }
  reader.close();
  return out;
}

describe("sync service crash recovery through the host", () => {
  it.each(["intent", "vaultWritten", "written", "acked", "vaultCleared"] as const)(
    "a host killed at %s: the next host recovers, every event once, nothing pending",
    async (point) => {
      const l = await lab(2);
      l.py.editAlert(1, 5, GID_A, "bridge-test-1");
      l.py.editAlert(2, 6, GID_B, "bridge-test-2", {}, "shared-txn");
      const killed = spawnHost(l.dir, { home: l.home, syncKillAt: point });
      await killed.ready;
      expect(await killed.exit).toBeNull(); // SIGKILL, at the point

      const next = spawnHost(l.dir, { home: l.home });
      await next.ready;
      await recovered(l.dir);
      await stopHost(l.dir);
      expect(await next.exit).toBe(0);
      expect(await vaultLogs(l)).toEqual([
        { events: 1, distinct: 1, intentOpen: false },
        { events: 1, distinct: 1, intentOpen: false },
      ]);
    },
  );

  it("a second host on the same data dir is refused while the first syncs", async () => {
    const l = await lab(1);
    const first = spawnHost(l.dir, { home: l.home });
    await first.ready;
    const second = spawnHost(l.dir, { home: l.home });
    expect(await second.exit).toBe(3);
    await stopHost(l.dir);
    expect(await first.exit).toBe(0);
  });

  it("reports its sync state in admin.status", async () => {
    const l = await lab(1);
    l.py.editAlert(1, 5, GID_A, "bridge-test-1");
    const host = spawnHost(l.dir, { home: l.home });
    await host.ready;
    expect(await recovered(l.dir)).toMatchObject({
      state: "idle",
      pending: 0,
      vaults: [{ ordinal: 0, intentOpen: false }],
    });
    await stopHost(l.dir);
    expect(await host.exit).toBe(0);
  });
});
