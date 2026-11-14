// The paired-vault list survives a recreated device store: each paired vault's log keeps a copy of its
// entry, and an empty list is rebuilt from those copies. A log without a copy (a pairing that never
// finished) is skipped; a log that may be a paired vault's but cannot be restored is counted, so the
// services never put the demo in its place. better-sqlite3 for expo-sqlite; synthetic ids only.
import { betterSqlite3Driver, type SqlDriver } from "@cashu/store";
import { DeviceStore, type PairedVault, pairedVaults, savePairedVault } from "@cashu/store/device";
import Database from "better-sqlite3";
import { readPairedEntry, restorePairedVaults, savePairedEntry } from "./vaultBootstrap";

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
