import { expect, it } from "vitest";
import {
  NATIVE_RELAY_FEATURE,
  NATIVE_RELAY_METHODS,
  relayActionResultSchema,
  relayStatusResultSchema,
  uiRelayAllowed,
} from "./relay.js";
import { roleAllows } from "./roles.js";

const VAULT = "0123456789abcdef0123456789abcdef";

it("admits only the five exact UI relay methods behind the feature", () => {
  expect(NATIVE_RELAY_METHODS).toEqual([
    "native.relay.status",
    "native.relay.enable",
    "native.relay.disable",
    "native.relay.purge",
    "native.relay.reconnect",
    "native.relay.keepFetching",
    "native.relay.syncNow",
  ]);
  for (const method of NATIVE_RELAY_METHODS) {
    expect(uiRelayAllowed(method, 8, [NATIVE_RELAY_FEATURE])).toBe(true);
    expect(uiRelayAllowed(method, 7, [NATIVE_RELAY_FEATURE])).toBe(false);
    expect(uiRelayAllowed(method, 8, [])).toBe(false);
    expect(roleAllows("ui", { t: "req", id: 1, method, params: { vault: VAULT } })).toBe(true);
    expect(roleAllows("mcp", { t: "req", id: 1, method, params: { vault: VAULT } })).toBe(false);
  }
  expect(uiRelayAllowed("native.relay.status.extra", 8, [NATIVE_RELAY_FEATURE])).toBe(false);
  expect(roleAllows("ui", { t: "req", id: 1, method: "native.relay.reset", params: {} })).toBe(
    false,
  );
});

it("parses the status and action results and refuses anything else", () => {
  const row = {
    configured: true,
    enabled: true,
    devices: 2,
    lastSyncAt: 2,
    quotaUntil: 9,
    identityLost: true,
    canReconnect: true,
  };
  expect(relayStatusResultSchema.parse(row)).toEqual(row);
  // The row carries what the copy needs and nothing more: no raw transport status, no uid.
  for (const extra of [{ status: { lastError: "quota" } }, { uid: "u" }, { lastError: "quota" }])
    expect(relayStatusResultSchema.safeParse({ ...row, ...extra }).success).toBe(false);
  // The two flags are required booleans.
  const { canReconnect: _c, ...noFlag } = row;
  expect(relayStatusResultSchema.safeParse(noFlag).success).toBe(false);
  expect(relayStatusResultSchema.safeParse({ ...row, quotaUntil: -1 }).success).toBe(false);
  expect(relayActionResultSchema.parse({ kind: "refused", reason: "not_admin" })).toEqual({
    kind: "refused",
    reason: "not_admin",
  });
  // A purge that stopped part way asks for a retry (not "offline").
  expect(relayActionResultSchema.parse({ kind: "refused", reason: "retry" })).toEqual({
    kind: "refused",
    reason: "retry",
  });
  // Reconnect without the vault's recovery secret.
  expect(
    relayActionResultSchema.parse({ kind: "refused", reason: "no_recovery_secret" }).kind,
  ).toBe("refused");
  expect(relayActionResultSchema.safeParse({ kind: "refused", reason: "nope" }).success).toBe(
    false,
  );
  expect(relayActionResultSchema.safeParse({ kind: "done", extra: 1 }).success).toBe(false);
});

it("carries the paused-since time and a value-free stuck summary, nothing else", () => {
  const base = {
    configured: true,
    enabled: true,
    devices: 1,
    identityLost: false,
    canReconnect: false,
  };
  const parsed = relayStatusResultSchema.parse({
    ...base,
    pausedSince: 1_000,
    stuck: { waiting: 1, rejected: 0, final: 2, since: 900, passes: 4 },
  });
  expect(parsed.pausedSince).toBe(1_000);
  expect(parsed.stuck).toEqual({ waiting: 1, rejected: 0, final: 2, since: 900, passes: 4 });
  // One writer's device id may travel (W3-7 item 4: the window names it from its device list); no
  // names, codes or positions: the summary is strict.
  const named = { waiting: 1, rejected: 0, final: 0, passes: 1, device: "d".repeat(32) };
  expect(relayStatusResultSchema.parse({ ...base, stuck: named }).stuck).toEqual(named);
  for (const bad of [
    { ...named, device: "Phone of Anna" },
    { ...named, code: "key_missing" },
    { ...named, seg: 1, offset: 0 },
  ])
    expect(relayStatusResultSchema.safeParse({ ...base, stuck: bad }).success).toBe(false);
  expect(relayStatusResultSchema.safeParse({ ...base, pausedSince: -1 }).success).toBe(false);
});

it("carries failing membership removals as a count, a time and device ids only", () => {
  const base = {
    configured: true,
    enabled: true,
    devices: 2,
    identityLost: false,
    canReconnect: false,
  };
  const id = "a".repeat(32);
  const failing = { ...base, removalsFailing: { devices: 1, since: 5, ids: [id] } };
  expect(relayStatusResultSchema.parse(failing)).toEqual(failing);
  for (const bad of [
    { devices: 0, since: 5, ids: [id] },
    { devices: 1, ids: [id] },
    { devices: 1, since: 5 },
    { devices: 1, since: 5, ids: [] },
    { devices: 1, since: 5, ids: ["Phone of Anna"] },
    { devices: 1, since: 5, ids: [id], device: "d" },
  ])
    expect(relayStatusResultSchema.safeParse({ ...base, removalsFailing: bad }).success).toBe(
      false,
    );
});
