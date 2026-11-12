// The device-local store: settings written by device commands (validated, one transaction, refusal
// writes nothing) and read live through the same watchQuery as a vault. Synthetic data only.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ok, refuse } from "../command.js";
import { watchQuery } from "../query.js";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import {
  currentVault,
  devicePhoneState,
  monthClosedSeen,
  setCurrentVault,
  setDevicePhoneState,
  setMonthClosedSeen,
} from "./settings.js";
import { DeviceStore, defineDeviceCommand } from "./store.js";

const VAULT = "5f0c3a9e81d24b7690ae13c7d2f4b856";

function openDevice(db = new Database(":memory:")): DeviceStore {
  return DeviceStore.open(betterSqlite3Driver(db));
}

describe("DeviceStore", () => {
  it("switches the current vault and notifies its readers", () => {
    const device = openDevice();
    const seen: (string | null)[] = [];
    watchQuery(device, currentVault, undefined, {
      onValue: (v) => seen.push(v),
      onError: (e) => {
        throw e;
      },
    });
    expect(device.run(setCurrentVault, { vault: VAULT })).toEqual({ ok: true, value: null });
    expect(device.run(setCurrentVault, { vault: null })).toEqual({ ok: true, value: null });
    expect(seen).toEqual([null, VAULT, null]);
    expect(currentVault.scope).toBe("device");
  });

  it("refuses invalid input and reads an undecodable stored value as unset", () => {
    const db = new Database(":memory:");
    const device = openDevice(db);
    expect(device.run(setCurrentVault, { vault: "not-a-vault" })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    db.prepare("INSERT INTO device_settings (key, value) VALUES ('currentVault', 'x')").run();
    expect(currentVault.run((sql, ...p) => device.read(sql, ...p), undefined)).toBeNull();
  });

  it("rolls a refused command back and announces nothing", () => {
    const device = openDevice();
    const writeThenRefuse = defineDeviceCommand({
      id: "test.writeThenRefuse",
      input: z.object({}),
      run(ctx) {
        ctx.setSetting("currentVault", VAULT);
        return refuse("changed_mind");
      },
    });
    let notified = 0;
    device.subscribe(["device_settings"], () => {
      notified += 1;
    });
    expect(device.run(writeThenRefuse, {})).toEqual({ ok: false, reason: "changed_mind" });
    expect(device.read("SELECT * FROM device_settings")).toEqual([]);
    expect(notified).toBe(0);
    expect(device.tablesRead("SELECT value FROM device_settings")).toEqual(
      new Set(["device_settings"]),
    );
    expect(() => device.read("DELETE FROM device_settings")).toThrow(/SELECT/);
    expect(
      device.run(defineDeviceCommand({ id: "test.ok", input: z.object({}), run: () => ok(1) }), {}),
    ).toEqual({ ok: true, value: 1 });
  });

  it("keeps the phone state: only the given fields change, undecodable values read as defaults", () => {
    const db = new Database(":memory:");
    const device = openDevice(db);
    const read = () => devicePhoneState.run((sql, ...p) => device.read(sql, ...p), undefined);
    expect(devicePhoneState.scope).toBe("device");
    expect(read()).toEqual({ incognito: false, lastOpenedAt: null });

    expect(device.run(setDevicePhoneState, { incognito: true })).toEqual({ ok: true, value: null });
    expect(read()).toEqual({ incognito: true, lastOpenedAt: null });
    const opened = "2026-11-12T06:40:00.000Z";
    expect(device.run(setDevicePhoneState, { lastOpenedAt: opened })).toEqual({
      ok: true,
      value: null,
    });
    expect(read()).toEqual({ incognito: true, lastOpenedAt: opened });
    expect(device.run(setDevicePhoneState, { incognito: false })).toEqual({
      ok: true,
      value: null,
    });
    expect(read()).toEqual({ incognito: false, lastOpenedAt: opened });
    expect(device.read("SELECT value FROM device_settings WHERE key = 'incognito'")).toEqual([
      { value: "0" },
    ]);
    expect(device.run(setDevicePhoneState, { lastOpenedAt: null })).toEqual({
      ok: true,
      value: null,
    });
    expect(read()).toEqual({ incognito: false, lastOpenedAt: null });

    expect(device.run(setDevicePhoneState, { lastOpenedAt: "yesterday" })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    db.prepare(
      "INSERT OR REPLACE INTO device_settings (key, value) VALUES ('incognito', 'yes')",
    ).run();
    db.prepare("INSERT INTO device_settings (key, value) VALUES ('lastOpenedAt', 'x')").run();
    expect(read()).toEqual({ incognito: false, lastOpenedAt: null });
  });

  it("does not notify readers when the phone state does not change", () => {
    const device = openDevice();
    device.run(setDevicePhoneState, { incognito: true });
    let notified = 0;
    device.subscribe(["device_settings"], () => {
      notified += 1;
    });
    device.run(setDevicePhoneState, { incognito: true });
    device.run(setDevicePhoneState, {});
    expect(notified).toBe(0);
  });

  it("remembers the closed month put away on this device, and only a valid month", () => {
    const db = new Database(":memory:");
    const device = openDevice(db);
    const OTHER = "6a1b2c3d4e5f60718293a4b5c6d7e8f9";
    const read = (vault = VAULT) =>
      monthClosedSeen.run((sql, ...p) => device.read(sql, ...p), { vault });
    expect(monthClosedSeen.scope).toBe("device");
    expect(read()).toBeNull();
    expect(device.run(setMonthClosedSeen, { vault: VAULT, month: "2026-10" })).toEqual({
      ok: true,
      value: null,
    });
    expect(read()).toBe("2026-10");
    // One profile's choice never reaches another profile on the same phone.
    expect(read(OTHER)).toBeNull();
    expect(device.run(setMonthClosedSeen, { vault: OTHER, month: "2026-09" })).toEqual({
      ok: true,
      value: null,
    });
    expect(read()).toBe("2026-10");
    expect(read(OTHER)).toBe("2026-09");
    expect(device.run(setMonthClosedSeen, { vault: VAULT, month: "2026-13" })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(read()).toBe("2026-10");
    let notified = 0;
    device.subscribe(["device_settings"], () => {
      notified += 1;
    });
    device.run(setMonthClosedSeen, { vault: VAULT, month: "2026-10" });
    expect(notified).toBe(0);
    db.prepare("UPDATE device_settings SET value = 'October' WHERE key = 'monthClosedSeen'").run();
    expect(read()).toBeNull();
  });
});
