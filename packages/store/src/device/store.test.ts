// The device-local store: settings written by device commands (validated, one transaction, refusal
// writes nothing) and read live through the same watchQuery as a vault. Synthetic data only.
import {
  DEFAULT_NOTIFICATION_PREFS,
  EMPTY_NOTIFICATION_LEDGER,
  type NotificationLedger,
} from "@cashu/domain/core/notifications";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ok, refuse } from "../command.js";
import { watchQuery } from "../query.js";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import {
  currentVault,
  deviceLock,
  devicePhoneState,
  markedAlerts,
  monthClosedSeen,
  notificationLedger,
  notificationPrefs,
  pricesFetchedAt,
  setAlertMarked,
  setCurrentVault,
  setDeviceLock,
  setDevicePhoneState,
  setMonthClosedSeen,
  setNotificationLedger,
  setNotificationPrefs,
  setPricesFetchedAt,
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

  it("keeps when this phone last fetched prices per vault, apart from the other phone state", () => {
    const db = new Database(":memory:");
    const device = openDevice(db);
    const OTHER = "6a1b2c3d4e5f60718293a4b5c6d7e8f9";
    const read = (vault = VAULT) =>
      pricesFetchedAt.run((sql, ...p) => device.read(sql, ...p), { vault });
    expect(pricesFetchedAt.scope).toBe("device");
    expect(read()).toBeNull();
    const fetched = "2026-11-12T06:31:00.000Z";
    expect(device.run(setPricesFetchedAt, { vault: VAULT, at: fetched })).toEqual({
      ok: true,
      value: null,
    });
    expect(read()).toBe(fetched);
    // A run fetches only its own vault's tickers: the other vault was not fetched.
    expect(read(OTHER)).toBeNull();
    const later = "2026-11-12T08:00:00.000Z";
    device.run(setPricesFetchedAt, { vault: OTHER, at: later });
    expect(read()).toBe(fetched);
    expect(read(OTHER)).toBe(later);
    device.run(setDevicePhoneState, { incognito: true, lastOpenedAt: "2026-11-12T07:00:00Z" });
    expect(read()).toBe(fetched);
    expect(device.run(setPricesFetchedAt, { vault: VAULT, at: "07:31" })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    expect(read()).toBe(fetched);
    let notified = 0;
    device.subscribe(["device_settings"], () => {
      notified += 1;
    });
    device.run(setPricesFetchedAt, { vault: VAULT, at: fetched });
    expect(notified).toBe(0);
    db.prepare("UPDATE device_settings SET value = 'x' WHERE key = 'pricesFetchedAt'").run();
    expect(read()).toBeNull();
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

describe("DeviceStore: notification settings", () => {
  const OTHER = "6a1b2c3d4e5f60718293a4b5c6d7e8f9";
  const ALERT = "01JD0000000000000000000001";
  const ALERT_2 = "01JD0000000000000000000002";

  function counted(device: DeviceStore): () => number {
    let notified = 0;
    device.subscribe(["device_settings"], () => {
      notified += 1;
    });
    return () => notified;
  }

  it("reads the default notification prefs and merges the user's choices over them, per vault", () => {
    const db = new Database(":memory:");
    const device = openDevice(db);
    const read = (vault = VAULT) =>
      notificationPrefs.run((sql, ...p) => device.read(sql, ...p), { vault });
    expect(notificationPrefs.scope).toBe("device");
    expect(read()).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(
      device.run(setNotificationPrefs, { vault: VAULT, prefs: { evening: true, weekly: false } }),
    ).toEqual({ ok: true, value: null });
    expect(
      device.run(setNotificationPrefs, { vault: VAULT, prefs: { alertsFired: true } }),
    ).toEqual({ ok: true, value: null });
    expect(read()).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      evening: true,
      weekly: false,
      alertsFired: true,
    });
    // One profile's choices never reach another profile on the same phone.
    expect(read(OTHER)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    // Device changes are always on: not settable.
    expect(
      device.run(setNotificationPrefs, { vault: VAULT, prefs: { deviceChanges: false } }),
    ).toEqual({ ok: false, reason: "invalid_input" });
    expect(device.run(setNotificationPrefs, { vault: "nope", prefs: { evening: true } })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    const notified = counted(device);
    device.run(setNotificationPrefs, { vault: VAULT, prefs: { evening: true } });
    device.run(setNotificationPrefs, { vault: OTHER, prefs: { weekly: true } });
    device.run(setNotificationPrefs, { vault: VAULT, prefs: {} });
    expect(notified()).toBe(0);
    db.prepare("UPDATE device_settings SET value = '{' WHERE key = 'notificationPrefs'").run();
    expect(read()).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("keeps the notification ledger per vault and writes it only when it changes", () => {
    const db = new Database(":memory:");
    const device = openDevice(db);
    const read = (vault = VAULT) =>
      notificationLedger.run((sql, ...p) => device.read(sql, ...p), { vault });
    const sent: NotificationLedger = {
      lastPlannedAt: "2026-11-12T09:00:00.000Z",
      alertsSentOn: { "2026-11-12": 1 },
      notifiedAlerts: { [ALERT]: "2026-11-12" },
      staleRung: 0,
      consentRung: null,
      monthClosedSentFor: "2026-10",
      weeklySentFor: "2026-11-15",
      eveningSentFor: null,
    };
    expect(notificationLedger.scope).toBe("device");
    expect(read()).toEqual(EMPTY_NOTIFICATION_LEDGER);
    expect(device.run(setNotificationLedger, { vault: VAULT, ledger: sent })).toEqual({
      ok: true,
      value: null,
    });
    expect(read()).toEqual(sent);
    expect(read(OTHER)).toEqual(EMPTY_NOTIFICATION_LEDGER);
    expect(
      device.run(setNotificationLedger, {
        vault: VAULT,
        ledger: { ...sent, alertsSentOn: { "12 Nov": 1 } },
      }),
    ).toEqual({ ok: false, reason: "invalid_input" });
    expect(
      device.run(setNotificationLedger, { vault: VAULT, ledger: { ...sent, staleRung: -1 } }),
    ).toEqual({ ok: false, reason: "invalid_input" });
    expect(
      device.run(setNotificationLedger, {
        vault: VAULT,
        ledger: { ...sent, notifiedAlerts: { "not a gid": "2026-11-12" } },
      }),
    ).toEqual({ ok: false, reason: "invalid_input" });
    expect(read()).toEqual(sent);
    const notified = counted(device);
    device.run(setNotificationLedger, { vault: VAULT, ledger: { ...sent } });
    expect(notified()).toBe(0);
    // A ledger stored before the told-alerts record existed reads with an empty one.
    const { notifiedAlerts: _, ...older } = sent;
    db.prepare("UPDATE device_settings SET value = ? WHERE key = 'notificationLedger'").run(
      JSON.stringify({ [VAULT]: older }),
    );
    expect(read()).toEqual({ ...sent, notifiedAlerts: {} });
    db.prepare("UPDATE device_settings SET value = 'x' WHERE key = 'notificationLedger'").run();
    expect(read()).toEqual(EMPTY_NOTIFICATION_LEDGER);
  });

  it("marks and unmarks alerts to tell this phone about, per vault", () => {
    const db = new Database(":memory:");
    const device = openDevice(db);
    const read = (vault = VAULT) =>
      markedAlerts.run((sql, ...p) => device.read(sql, ...p), { vault });
    expect(markedAlerts.scope).toBe("device");
    expect(read()).toEqual([]);
    device.run(setAlertMarked, { vault: VAULT, alert: ALERT_2, marked: true });
    expect(device.run(setAlertMarked, { vault: VAULT, alert: ALERT, marked: true })).toEqual({
      ok: true,
      value: null,
    });
    expect(read()).toEqual([ALERT, ALERT_2]);
    expect(read(OTHER)).toEqual([]);
    device.run(setAlertMarked, { vault: VAULT, alert: ALERT_2, marked: false });
    expect(read()).toEqual([ALERT]);
    expect(device.run(setAlertMarked, { vault: VAULT, alert: "CD Projekt", marked: true })).toEqual(
      { ok: false, reason: "invalid_input" },
    );
    const notified = counted(device);
    device.run(setAlertMarked, { vault: VAULT, alert: ALERT, marked: true });
    device.run(setAlertMarked, { vault: VAULT, alert: ALERT_2, marked: false });
    expect(notified()).toBe(0);
    device.run(setAlertMarked, { vault: VAULT, alert: ALERT, marked: false });
    expect(read()).toEqual([]);
    db.prepare("UPDATE device_settings SET value = '[1]' WHERE key = 'markedAlerts'").run();
    expect(read()).toEqual([]);
  });

  it("keeps the app lock choice device-wide", () => {
    const db = new Database(":memory:");
    const device = openDevice(db);
    const read = () => deviceLock.run((sql, ...p) => device.read(sql, ...p), undefined);
    expect(deviceLock.scope).toBe("device");
    expect(read()).toEqual({ appLock: null });
    expect(device.run(setDeviceLock, { appLock: true })).toEqual({ ok: true, value: null });
    expect(read()).toEqual({ appLock: true });
    expect(device.run(setDeviceLock, { appLock: "yes" })).toEqual({
      ok: false,
      reason: "invalid_input",
    });
    const notified = counted(device);
    device.run(setDeviceLock, { appLock: true });
    expect(notified()).toBe(0);
    device.run(setDeviceLock, { appLock: false });
    expect(read()).toEqual({ appLock: false });
    db.prepare("UPDATE device_settings SET value = 'on' WHERE key = 'appLock'").run();
    expect(read()).toEqual({ appLock: null });
  });
});
