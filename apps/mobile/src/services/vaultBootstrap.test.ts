// The paired-vault list survives a recreated device store: each paired vault's log keeps a copy of its
// entry, and an empty list is rebuilt from those copies. A log without a copy (a pairing that never
// finished) is skipped; a log that may be a paired vault's but cannot be restored is counted, so the
// services never put the demo in its place. better-sqlite3 for expo-sqlite; synthetic ids only.
import { betterSqlite3Driver, type SqlDriver } from "@cashu/store";
import {
  DeviceStore,
  forgetPairedVault,
  type PairedVault,
  pairedVaults,
  savePairedVault,
} from "@cashu/store/device";
import { SqlLogTransport } from "@cashu/store/sync";
import { crypto } from "@cashu/sync";
import Database from "better-sqlite3";
import { memoryKeyStore, runtime } from "../selftest/testing/runtime";
import { createVaultQueue } from "./commandQueue";
import {
  createVaultLog,
  forgetVault,
  type JoinedVault,
  readPairedEntry,
  readVaultBootstrap,
  restorePairedVaults,
  savePairedEntry,
  storeJoinedInQueue,
} from "./vaultBootstrap";

const A: PairedVault = {
  vaultId: "5f0c3a9e81d24b7690ae13c7d2f4b856",
  deviceId: "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
  role: "owner",
  pairedAt: 1_793_448_000_000,
  name: "Ala",
};
const B: PairedVault = { ...A, vaultId: "6f0c3a9e81d24b7690ae13c7d2f4b857", role: "partner" };
const ORPHAN = "7f0c3a9e81d24b7690ae13c7d2f4b858";
const TORN = "8f0c3a9e81d24b7690ae13c7d2f4b859";

/** A disk of log files that stay open across "launches" (closing a port's handle keeps the data). */
function logDisk() {
  const dbs = new Map<string, Database.Database>();
  const open = (vault: string): SqlDriver => {
    let db = dbs.get(vault);
    if (db === undefined) {
      db = new Database(":memory:");
      dbs.set(vault, db);
    }
    const driver = betterSqlite3Driver(db);
    return { ...driver, close: () => undefined } as SqlDriver;
  };
  return { open };
}

function freshDeviceStore() {
  const device = DeviceStore.open(betterSqlite3Driver(new Database(":memory:")));
  return {
    device,
    list: () => pairedVaults.run((sql, ...p) => device.read(sql, ...p), undefined),
    save: (entry: unknown) => device.run(savePairedVault, entry as PairedVault).ok,
  };
}

describe("the paired entry copy in a vault's log", () => {
  it("round-trips, is absent in a log that never had one and replaces the previous copy", () => {
    const log = logDisk().open(A.vaultId);
    expect(readPairedEntry(log)).toBeUndefined();
    savePairedEntry(log, A);
    expect(readPairedEntry(log)).toEqual(A);
    savePairedEntry(log, { ...A, name: "Ala K" });
    expect(readPairedEntry(log)).toEqual({ ...A, name: "Ala K" });
    log.prepare("UPDATE paired_entry SET entry = '{oops'").run();
    expect(() => readPairedEntry(log)).toThrow("paired_entry_corrupt");
  });
});

describe("restorePairedVaults", () => {
  it("rebuilds the list of a recreated device store from the logs' copies", () => {
    const disk = logDisk();
    for (const entry of [A, B]) savePairedEntry(disk.open(entry.vaultId), entry);
    // The orphan of a pairing that stopped before `addPairedVault`: a log without a copy.
    disk.open(ORPHAN).exec("CREATE TABLE vault_bootstrap (vault TEXT)");
    // The device store was torn and recreated empty.
    const store = freshDeviceStore();
    expect(store.list()).toEqual([]);
    const result = restorePairedVaults({
      vaults: [A.vaultId, ORPHAN, B.vaultId],
      openLog: disk.open,
      save: store.save,
    });
    expect(result).toEqual({ restored: 2, unreadable: 0 });
    expect(store.list()).toEqual([A, B]);
  });

  it("counts every log it could not restore, so the demo never takes the vaults' place", () => {
    const disk = logDisk();
    savePairedEntry(disk.open(A.vaultId), A);
    // A copy that names another vault than its file, and a copy the device store refuses.
    savePairedEntry(disk.open(B.vaultId), { ...B, vaultId: ORPHAN });
    savePairedEntry(disk.open(ORPHAN), { ...A, vaultId: ORPHAN, role: "child" as "owner" });
    const store = freshDeviceStore();
    const result = restorePairedVaults({
      vaults: [A.vaultId, B.vaultId, ORPHAN, TORN],
      openLog: (vault) => {
        // The key does not open this one (a torn first page).
        if (vault === TORN) throw new Error("db_key_mismatch: the key does not open this file");
        return disk.open(vault);
      },
      save: store.save,
    });
    expect(result).toEqual({ restored: 1, unreadable: 3 });
    expect(store.list()).toEqual([A]);

    // Nothing restorable at all: an empty list with unreadable files (the services' `unlisted`).
    const empty = freshDeviceStore();
    expect(
      restorePairedVaults({
        vaults: [TORN],
        openLog: () => {
          throw new Error("db_key_mismatch: the key does not open this file");
        },
        save: empty.save,
      }),
    ).toEqual({ restored: 0, unreadable: 1 });
    expect(empty.list()).toEqual([]);
  });
});

// Review K5: the pairing track's preconditions on the storing step and the forget flow.
describe("re-pairing a vault this phone holds (K5)", () => {
  let sodium: crypto.Sodium;
  beforeAll(async () => {
    sodium = crypto.fromLibsodium(await runtime(), { aead: "noble" });
  });

  /** A paired log of a fresh vault (no own bytes yet) and a welcome of the same vault for a new device. */
  function heldVault() {
    const recovery = crypto.recoveryIdentity(sodium, crypto.createRecoveryKey(sodium).phrase);
    const mac = crypto.createDeviceIdentity(sodium);
    const { ring } = crypto.createVaultWithRecovery(sodium, recovery, mac);
    const first = crypto.createDeviceIdentity(sodium);
    const log = betterSqlite3Driver(new Database(":memory:"));
    createVaultLog(log, {
      ring,
      device: first.deviceId,
      kind: "paired",
      state: "ready",
      certificates: [],
      registryEvents: [],
      provenance: () => undefined,
      now: Date.now,
    });
    const own = new SqlLogTransport({ driver: log, vault: ring.vaultId });
    const append = () => own.append(ring.vaultId, first.deviceId, 1, 0, new Uint8Array([1, 2, 3]));
    const joined: JoinedVault = {
      identity: crypto.createDeviceIdentity(sodium),
      ring,
      certificate: new Uint8Array([9]),
      registryEvents: [],
      inviter: mac.deviceId,
    };
    return { log, ring, first, joined, append, keyStore: memoryKeyStore(sodium) };
  }

  it("runs the check inside the vault's queue after the session closed, so a queued command counts", async () => {
    const held = heldVault();
    const queue = createVaultQueue();
    const order: string[] = [];
    // A command of the still-open session, queued before the store: it appends an own frame.
    void queue.run(held.ring.vaultId, async () => {
      await new Promise((r) => setTimeout(r, 5));
      await held.append();
      order.push("command");
    });
    await expect(
      storeJoinedInQueue(
        {
          queue,
          session: {
            close: async () => {
              order.push("session closed");
            },
          },
          keyStore: held.keyStore,
          driver: held.log,
          now: Date.now,
        },
        held.joined,
      ),
    ).rejects.toThrow("unpushed_changes");
    expect(order).toEqual(["session closed", "command"]);
    // Nothing was replaced: the old device's bootstrap and frame stay, no new keys.
    expect(readVaultBootstrap(held.log)?.device).toBe(held.first.deviceId);
    expect(await held.keyStore.get(crypto.keyringName(held.ring.vaultId))).toBeNull();
  });

  it("replaces the copy of a removed vault with unsent changes only after the owner's explicit yes", async () => {
    const held = heldVault();
    await held.append();
    const ports = {
      queue: createVaultQueue(),
      session: undefined,
      keyStore: held.keyStore,
      driver: held.log,
      now: Date.now,
    };
    await expect(storeJoinedInQueue(ports, held.joined)).rejects.toThrow("unpushed_changes");
    await storeJoinedInQueue(ports, held.joined, { discardUnpushed: true });
    expect(readVaultBootstrap(held.log)?.device).toBe(held.joined.identity.deviceId);
    const segments = await new SqlLogTransport({ driver: held.log, vault: held.ring.vaultId }).list(
      held.ring.vaultId,
    );
    expect(segments).toEqual([]);
    expect(await held.keyStore.get(crypto.keyringName(held.ring.vaultId))).not.toBeNull();
  });
});

describe("forgetVault (K5)", () => {
  /** One forget of A, its `kill`-th step dying (0: none), then the next launch's list. */
  async function forgetKilledAt(kill: number) {
    const files = new Map<string, Database.Database>();
    const open = (vault: string): SqlDriver => {
      let db = files.get(vault);
      if (db === undefined) {
        db = new Database(":memory:");
        files.set(vault, db);
      }
      return { ...betterSqlite3Driver(db), close: () => undefined } as SqlDriver;
    };
    // The LAST paired vault: an empty list afterwards is rebuilt from the logs' copies.
    savePairedEntry(open(A.vaultId), A);
    const store = freshDeviceStore();
    store.save(A);
    let step = 0;
    const die = () => {
      step++;
      if (step === kill) throw new Error("killed");
    };
    let forgotten = false;
    await forgetVault({
      deleteLog: () => {
        die();
        files.delete(A.vaultId);
      },
      deleteView: () => die(),
      forgetEntry: () => {
        die();
        forgotten = true;
        return store.device.run(forgetPairedVault, { vaultId: A.vaultId }).ok;
      },
      deleteKeys: async () => die(),
    }).catch(() => undefined);
    // Next launch: an empty list is restored from whatever logs remain.
    if (store.list().length === 0) {
      restorePairedVaults({ vaults: [...files.keys()], openLog: open, save: store.save });
    }
    return { listed: store.list().map((e) => e.vaultId), forgotten };
  }

  it.each([0, 1, 2, 3, 4])(
    "never brings a forgotten vault back (kill at step %i)",
    async (kill) => {
      const { listed, forgotten } = await forgetKilledAt(kill);
      // Listed exactly while the entry was not dropped yet (a later forget finishes the job).
      expect(listed).toEqual(forgotten ? [] : [A.vaultId]);
    },
  );
});
