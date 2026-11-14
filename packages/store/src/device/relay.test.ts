// The relay switch per vault in device_settings: written by its device command, read back through zod
// (an undecodable value reads as unset), never shared between vaults. Synthetic ids only.
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { runQuery } from "../query.js";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import {
  relayDeviceRole,
  relayMemberRole,
  relayMemberUid,
  relaySetting,
  relaySettingKey,
  relaySettings,
  setRelaySetting,
} from "./relay.js";
import { DeviceStore } from "./store.js";

const VAULT = "5f0c3a9e81d24b7690ae13c7d2f4b856";
const OTHER = "6f0c3a9e81d24b7690ae13c7d2f4b856";
const DEVICE = "d1000000000000000000000000000001";

const ON = {
  enabled: true,
  project: "demo-cashu",
  enabledAt: 1_000,
  memberUids: { [DEVICE]: "uidA" },
};

it("writes, reads and clears one vault's relay switch without touching another vault", () => {
  const db = new Database(":memory:");
  const device = DeviceStore.open(betterSqlite3Driver(db));
  expect(runQuery(device, relaySetting, { vault: VAULT }).value).toBeNull();
  expect(device.run(setRelaySetting, { vault: VAULT, value: ON })).toEqual({
    ok: true,
    value: null,
  });
  expect(runQuery(device, relaySetting, { vault: VAULT }).value).toEqual(ON);
  expect(runQuery(device, relaySetting, { vault: OTHER }).value).toBeNull();
  expect(runQuery(device, relaySettings, undefined).value).toEqual({ [VAULT]: ON });

  // An undecodable stored value reads as unset; the list leaves it out.
  db.prepare("INSERT INTO device_settings (key, value) VALUES (?, ?)").run(
    relaySettingKey(OTHER),
    "{not json",
  );
  expect(runQuery(device, relaySetting, { vault: OTHER }).value).toBeNull();
  expect(Object.keys(runQuery(device, relaySettings, undefined).value)).toEqual([VAULT]);

  expect(device.run(setRelaySetting, { vault: VAULT, value: null }).ok).toBe(true);
  expect(runQuery(device, relaySetting, { vault: VAULT }).value).toBeNull();
});

it("refuses a malformed vault, project or uid", () => {
  const device = DeviceStore.open(betterSqlite3Driver(new Database(":memory:")));
  expect(device.run(setRelaySetting, { vault: "nope", value: ON }).ok).toBe(false);
  expect(
    device.run(setRelaySetting, { vault: VAULT, value: { ...ON, project: "Bad Project" } }).ok,
  ).toBe(false);
  expect(
    device.run(setRelaySetting, {
      vault: VAULT,
      value: { ...ON, memberUids: { [DEVICE]: "a/b" } },
    }).ok,
  ).toBe(false);
  expect(runQuery(device, relaySetting, { vault: VAULT }).value).toBeNull();
});

it("keeps the sync history beside the switch and still reads a setting written without it", () => {
  const device = DeviceStore.open(betterSqlite3Driver(new Database(":memory:")));
  const withHistory = { ...ON, lastCompletePullAt: 5_000, pausedSince: 6_000 };
  expect(device.run(setRelaySetting, { vault: VAULT, value: withHistory }).ok).toBe(true);
  expect(runQuery(device, relaySetting, { vault: VAULT }).value).toEqual(withHistory);
  expect(device.run(setRelaySetting, { vault: OTHER, value: ON }).ok).toBe(true);
  expect(runQuery(device, relaySetting, { vault: OTHER }).value).toEqual(ON);
  expect(device.run(setRelaySetting, { vault: VAULT, value: { ...ON, pausedSince: -1 } }).ok).toBe(
    false,
  );
});

it("keeps a role per device beside its uid and still reads a bare uid (role unknown)", () => {
  const device = DeviceStore.open(betterSqlite3Driver(new Database(":memory:")));
  const PHONE = "d1000000000000000000000000000002";
  const withRoles = {
    ...ON,
    memberUids: {
      [DEVICE]: { uid: "uidA", role: "admin" as const },
      [PHONE]: { uid: "uidP", role: "member" as const },
    },
  };
  expect(device.run(setRelaySetting, { vault: VAULT, value: withRoles }).ok).toBe(true);
  const read = runQuery(device, relaySetting, { vault: VAULT }).value;
  expect(read).toEqual(withRoles);
  expect(relayMemberRole(read?.memberUids[DEVICE])).toBe("admin");
  expect(relayMemberRole(read?.memberUids[PHONE])).toBe("member");
  expect(relayMemberUid(read?.memberUids[PHONE] ?? "")).toBe("uidP");
  // A setting written before roles were kept: the uid reads, the role is unknown.
  expect(device.run(setRelaySetting, { vault: OTHER, value: ON }).ok).toBe(true);
  const bare = runQuery(device, relaySetting, { vault: OTHER }).value?.memberUids[DEVICE];
  expect(bare).toBe("uidA");
  expect(relayMemberRole(bare)).toBeUndefined();
  expect(relayMemberUid(bare ?? "")).toBe("uidA");
  // An unknown role or extra keys are refused.
  for (const bad of [
    { uid: "uidA", role: "owner" },
    { uid: "uidA", role: "admin", extra: 1 },
  ])
    expect(
      device.run(setRelaySetting, {
        vault: VAULT,
        value: { ...ON, memberUids: { [DEVICE]: bad as never } },
      }).ok,
    ).toBe(false);
});

it("keeps each device's kind apart from its membership (a purge or re-pair drops only the binding)", () => {
  const db = new Database(":memory:");
  const device = DeviceStore.open(betterSqlite3Driver(db));
  const PHONE = "d2000000000000000000000000000002";
  const LEGACY = "d3000000000000000000000000000003";
  // After a purge: only this Mac stays bound, the phone's kind is still known; a legacy bare entry
  // has no kind until one is learnt.
  const purged = {
    ...ON,
    memberUids: { [DEVICE]: { uid: "uidA", role: "admin" as const }, [LEGACY]: "uidL" },
    roles: { [PHONE]: "member" as const },
  };
  expect(device.run(setRelaySetting, { vault: VAULT, value: purged }).ok).toBe(true);
  const read = runQuery(device, relaySetting, { vault: VAULT }).value;
  expect(read).toEqual(purged);
  if (read === null) throw new Error("unread");
  expect(relayDeviceRole(read, PHONE)).toBe("member");
  expect(relayDeviceRole(read, DEVICE)).toBe("admin");
  expect(relayDeviceRole(read, LEGACY)).toBeUndefined();
  // The kept kind wins over a membership entry.
  expect(
    relayDeviceRole({ memberUids: { [LEGACY]: "uidL" }, roles: { [LEGACY]: "member" } }, LEGACY),
  ).toBe("member");
  expect(
    device.run(setRelaySetting, {
      vault: VAULT,
      value: { ...ON, roles: { [PHONE]: "owner" as never } },
    }).ok,
  ).toBe(false);
});
