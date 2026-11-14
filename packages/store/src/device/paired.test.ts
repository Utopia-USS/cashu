// The phone's paired-vault inventory: add, replace by vault, forget; an undecodable entry is left out
// alone and kept as stored; a value that is not a list reads as none and is never overwritten.
// Synthetic ids only.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import { forgetPairedVault, type PairedVault, pairedVaults, savePairedVault } from "./paired.js";
import { DeviceStore } from "./store.js";

const A: PairedVault = {
  vaultId: "5f0c3a9e81d24b7690ae13c7d2f4b856",
  deviceId: "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
  role: "owner",
  pairedAt: 1_793_448_000_000,
  name: "New profile",
};
const B: PairedVault = { ...A, vaultId: "6f0c3a9e81d24b7690ae13c7d2f4b857", role: "partner" };

function open(db = new Database(":memory:")) {
  const device = DeviceStore.open(betterSqlite3Driver(db));
  const read = () => pairedVaults.run((sql, ...p) => device.read(sql, ...p), undefined);
  return { db, device, read };
}

describe("pairedVaults", () => {
  it("adds in pairing order, replaces an entry of the same vault and forgets one", () => {
    const { device, read } = open();
    expect(read()).toEqual([]);
    expect(device.run(savePairedVault, A)).toEqual({ ok: true, value: null });
    device.run(savePairedVault, B);
    device.run(savePairedVault, { ...A, name: "Anna", role: "partner" });
    expect(read()).toEqual([{ ...A, name: "Anna", role: "partner" }, B]);
    device.run(forgetPairedVault, { vaultId: A.vaultId });
    expect(read()).toEqual([B]);
    device.run(forgetPairedVault, { vaultId: B.vaultId });
    expect(read()).toEqual([]);
  });

  it("refuses an invalid entry and reads an undecodable value as none", () => {
    const { db, device, read } = open();
    expect(device.run(savePairedVault, { ...A, deviceId: "nope" })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    db.prepare(
      "INSERT INTO device_settings (key, value) VALUES ('pairedVaults', '[{\"x\":1}]')",
    ).run();
    expect(read()).toEqual([]);
  });

  it("keeps the other vaults when one entry does not decode, and keeps that entry's raw value", () => {
    const { db, device, read } = open();
    // A role a later version adds: this entry alone does not decode.
    const future = { ...B, role: "child" };
    const raw = JSON.stringify([A, future]);
    db.prepare("INSERT INTO device_settings (key, value) VALUES ('pairedVaults', ?)").run(raw);
    expect(read()).toEqual([A]);
    const stored = () =>
      JSON.parse(
        (
          db.prepare("SELECT value FROM device_settings WHERE key = 'pairedVaults'").get() as {
            value: string;
          }
        ).value,
      ) as unknown[];
    // A name update of A and a third vault: the undecodable entry stays untouched, in its place.
    const C: PairedVault = { ...A, vaultId: "7f0c3a9e81d24b7690ae13c7d2f4b858" };
    device.run(savePairedVault, { ...A, name: "Anna" });
    device.run(savePairedVault, C);
    expect(stored()).toEqual([{ ...A, name: "Anna" }, future, C]);
    expect(read()).toEqual([{ ...A, name: "Anna" }, C]);
    device.run(forgetPairedVault, { vaultId: C.vaultId });
    expect(stored()).toEqual([{ ...A, name: "Anna" }, future]);
    // Pairing that vault again replaces the damaged entry with a good one.
    device.run(savePairedVault, B);
    expect(read()).toEqual([{ ...A, name: "Anna" }, B]);
  });

  it("never overwrites a value that is not a list", () => {
    const { db, device, read } = open();
    db.prepare(
      "INSERT INTO device_settings (key, value) VALUES ('pairedVaults', '[{\"vaultId\"')",
    ).run();
    expect(read()).toEqual([]);
    expect(device.run(savePairedVault, A)).toEqual({ ok: false, reason: "paired_vaults_corrupt" });
    expect(device.run(forgetPairedVault, { vaultId: A.vaultId })).toEqual({
      ok: false,
      reason: "paired_vaults_corrupt",
    });
    expect(
      db.prepare("SELECT value FROM device_settings WHERE key = 'pairedVaults'").get(),
    ).toEqual({ value: '[{"vaultId"' });
  });
});
