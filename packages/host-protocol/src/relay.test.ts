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

it("admits only the four exact UI relay methods behind the feature", () => {
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
  expect(
    relayStatusResultSchema.parse({
      configured: true,
      enabled: true,
      status: { lastOk: 2, lastError: "quota", lastErrorAt: 3 },
      devices: 2,
      lastSyncAt: 2,
    }).status.lastError,
  ).toBe("quota");
  expect(
    relayStatusResultSchema.safeParse({
      configured: true,
      enabled: true,
      status: { lastError: "boom" },
      devices: 0,
    }).success,
  ).toBe(false);
  expect(relayActionResultSchema.parse({ kind: "refused", reason: "not_admin" })).toEqual({
    kind: "refused",
    reason: "not_admin",
  });
  // A purge that stopped part way asks for a retry (not "offline").
  expect(relayActionResultSchema.parse({ kind: "refused", reason: "retry" })).toEqual({
    kind: "refused",
    reason: "retry",
  });
  expect(relayActionResultSchema.safeParse({ kind: "refused", reason: "nope" }).success).toBe(
    false,
  );
  expect(relayActionResultSchema.safeParse({ kind: "done", extra: 1 }).success).toBe(false);
});

it("carries the paused-since time and a value-free stuck summary, nothing else", () => {
  const base = {
    configured: true,
    enabled: true,
    status: { lastError: "unavailable" },
    devices: 1,
  };
  const parsed = relayStatusResultSchema.parse({
    ...base,
    pausedSince: 1_000,
    stuck: { waiting: 1, rejected: 0, final: 2, since: 900, passes: 4 },
  });
  expect(parsed.pausedSince).toBe(1_000);
  expect(parsed.stuck).toEqual({ waiting: 1, rejected: 0, final: 2, since: 900, passes: 4 });
  // No device ids, codes or positions travel: the summary is strict.
  expect(
    relayStatusResultSchema.safeParse({
      ...base,
      stuck: { waiting: 1, rejected: 0, final: 0, passes: 1, device: "d".repeat(32) },
    }).success,
  ).toBe(false);
  expect(relayStatusResultSchema.safeParse({ ...base, pausedSince: -1 }).success).toBe(false);
});
