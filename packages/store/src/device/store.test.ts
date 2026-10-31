// The device-local store: settings written by device commands (validated, one transaction, refusal
// writes nothing) and read live through the same watchQuery as a vault. Synthetic data only.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ok, refuse } from "../command.js";
import { watchQuery } from "../query.js";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import { currentVault, setCurrentVault } from "./settings.js";
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
});
