import type { RelayStatusResult } from "@cashu/host-protocol";
import { expect, it } from "vitest";
import { fetchPausedLine, syncStatusLine } from "./syncStatusLine.js";

/** Local noon (the day lines follow the local calendar). */
const NOW = new Date(2026, 10, 14, 12, 0).getTime();
const MIN = 60_000;
/** A configured, enabled, healthy status (synthetic). */
const base: RelayStatusResult = {
  configured: true,
  enabled: true,
  devices: 3,
  lastSyncAt: NOW - 2 * MIN,
  identityLost: false,
  canReconnect: false,
};
const A = "a".repeat(32);
const B = "b".repeat(32);
const names: Record<string, string> = { [A]: "Old iPhone" };
const line = (overrides: Partial<RelayStatusResult>) =>
  syncStatusLine({ ...base, ...overrides }, NOW, (device) => names[device] ?? null);
const syncedToday = { kind: "synced", at: NOW - 2 * MIN, day: "today", devices: 3 };

it("hides the row without a sync config, even with other fields set", () => {
  expect(line({ configured: false, enabled: true, pausedSince: NOW })).toEqual({ kind: "hidden" });
});

it("shows only the switch when sync is off", () => {
  expect(line({ enabled: false, pausedSince: NOW })).toEqual({ kind: "off" });
});

it("offers Reconnect sync when the identity was lost and a secret is kept", () => {
  expect(line({ identityLost: true, canReconnect: true, pausedSince: NOW })).toEqual({
    kind: "reconnect",
  });
});

it("says reconnect cannot help when the identity was lost without a secret", () => {
  expect(line({ identityLost: true, canReconnect: false })).toEqual({
    kind: "reconnect_unavailable",
  });
});

it("shows the quota line while the quota holds, before a pause", () => {
  expect(line({ quotaUntil: NOW + MIN, pausedSince: NOW - MIN })).toEqual({ kind: "quota" });
});

it("drops a quota that ran out", () => {
  expect(line({ quotaUntil: NOW - MIN })).toEqual(syncedToday);
});

it("shows the pause with its start time", () => {
  expect(line({ pausedSince: NOW - 30 * MIN })).toEqual({ kind: "paused", since: NOW - 30 * MIN });
});

it("shows unreadable changes after repeated failure before waiting ones", () => {
  expect(line({ stuck: { waiting: 1, rejected: 1, final: 0, passes: 4, device: A } })).toEqual({
    kind: "stuck_failed",
    device: "Old iPhone",
  });
});

it("shows waiting changes, named when the device list knows the writer, else device-less", () => {
  expect(line({ stuck: { waiting: 2, rejected: 0, final: 0, passes: 1, device: A } })).toEqual({
    kind: "stuck_waiting",
    device: "Old iPhone",
  });
  // An id the list does not know, or no id at all: null, never the id or a stand-in name.
  expect(line({ stuck: { waiting: 2, rejected: 0, final: 0, passes: 1, device: B } })).toEqual({
    kind: "stuck_waiting",
    device: null,
  });
  expect(line({ stuck: { waiting: 0, rejected: 1, final: 0, passes: 1 } })).toEqual({
    kind: "stuck_failed",
    device: null,
  });
});

it("ranks a failing removal above the quota, a pause, stuck streams and synced", () => {
  const failing = { devices: 2, since: NOW - 60 * MIN, ids: [A, B] };
  expect(
    line({
      removalsFailing: failing,
      quotaUntil: NOW + MIN,
      pausedSince: NOW - MIN,
      stuck: { waiting: 0, rejected: 1, final: 0, passes: 3, device: A },
    }),
  ).toEqual({ kind: "removal_failing", device: "Old iPhone" });
  // The longest failing device names the line; an unknown one reads device-less.
  expect(line({ removalsFailing: { ...failing, ids: [B, A] } })).toEqual({
    kind: "removal_failing",
    device: null,
  });
  // A lost identity stays first: this Mac's own membership is the bigger problem.
  expect(line({ removalsFailing: failing, identityLost: true, canReconnect: true })).toEqual({
    kind: "reconnect",
  });
});

it("ignores streams that are only final", () => {
  expect(line({ stuck: { waiting: 0, rejected: 0, final: 1, passes: 1 } })).toEqual(syncedToday);
});

it("says when it synced as a clock time on today, yesterday or an earlier day", () => {
  const today = new Date(2026, 10, 14, 0, 5).getTime();
  const yesterday = new Date(2026, 10, 13, 22, 40).getTime();
  const earlier = new Date(2026, 10, 12, 22, 40).getTime();
  expect(line({ lastSyncAt: today })).toEqual({
    kind: "synced",
    at: today,
    day: "today",
    devices: 3,
  });
  expect(line({ lastSyncAt: yesterday })).toEqual({
    kind: "synced",
    at: yesterday,
    day: "yesterday",
    devices: 3,
  });
  expect(line({ lastSyncAt: earlier })).toEqual({
    kind: "synced",
    at: earlier,
    day: "earlier",
    devices: 3,
  });
});

it("waits for the first sync when no pass reached it yet", () => {
  const { lastSyncAt: _drop, ...never } = base;
  expect(syncStatusLine(never, NOW)).toEqual({ kind: "first_sync", devices: 3 });
});

it("picks the bank fetch paused variant from the sync switch", () => {
  expect(fetchPausedLine(undefined, base)).toBeNull();
  expect(fetchPausedLine("offline_too_long", base)).toBe("outage");
  expect(fetchPausedLine("offline_too_long", { ...base, enabled: false })).toBe("sync_off");
  expect(fetchPausedLine("offline_too_long", { ...base, configured: false })).toBe("sync_off");
  expect(fetchPausedLine("offline_too_long", null)).toBe("sync_off");
});
