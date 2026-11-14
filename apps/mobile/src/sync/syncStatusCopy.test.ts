// The status line and the owner-facing vault states from a vault's sync status (synthetic statuses).
import type { VaultSyncStatus } from "../services/vaultEngine";
import { syncLineOf, vaultNoticeOf } from "./syncStatusCopy";

const ok: VaultSyncStatus = {
  vault: "v",
  phase: "ready",
  syncing: false,
  remote: true,
  unpushed: false,
};
const at = Date.UTC(2026, 10, 14, 9, 12);

describe("vaultNoticeOf", () => {
  it("tells removed (revoked in the registry) from sync turned off (only refused)", () => {
    const refused = { ...ok, relay: { lastError: "forbidden" as const, lastErrorAt: at } };
    expect(vaultNoticeOf({ ...refused, phase: "removed" })).toEqual({ kind: "removed" });
    expect(vaultNoticeOf(refused)).toEqual({ kind: "syncOff" });
  });

  it("asks for a re-pairing only for files or keys that do not open, never for an outage", () => {
    for (const failure of ["needs_repair", "keyring_unreadable", "keystore_unavailable"]) {
      expect(vaultNoticeOf({ ...ok, phase: "failed", failure })).toEqual({ kind: "needsRepair" });
    }
    const outage = { ...ok, relay: { lastError: "unavailable" as const, lastErrorAt: at } };
    expect(vaultNoticeOf(outage)).toBeNull();
    expect(vaultNoticeOf({ ...ok, phase: "failed", failure: "relay_unreachable" })).toBeNull();
    expect(vaultNoticeOf(ok)).toBeNull();
  });
});

describe("syncLineOf", () => {
  it("shows the replay only once it ran long enough, ahead of everything else", () => {
    const replaying = {
      ...ok,
      replay: { done: 2, total: 5 },
      relay: { lastError: "quota" as const, lastErrorAt: at },
    };
    expect(syncLineOf(replaying, { replayShown: true })).toEqual({ kind: "replay", percent: 40 });
    expect(syncLineOf(replaying, { replayShown: false })).toEqual({ kind: "quota" });
  });

  it("names the stuck writer, then today's limit, then paused since the last call that worked", () => {
    const stuck: VaultSyncStatus = {
      ...ok,
      stuck: [
        { device: "d1", name: "iPad", kind: "waiting", since: at - 5 },
        { device: "d2", kind: "final", since: at - 9 },
        { device: "d3", name: "MacBook", kind: "rejected", since: at },
      ],
      relay: { lastError: "quota", lastErrorAt: at },
    };
    // A failed writer comes first, the longest stuck first; an unnamed one is shown without a name.
    expect(syncLineOf(stuck, { replayShown: false })).toEqual({ kind: "stuck", failed: true });
    const named = { ...stuck, stuck: [stuck.stuck?.[0], stuck.stuck?.[2]].filter((w) => !!w) };
    expect(syncLineOf(named as VaultSyncStatus, { replayShown: false })).toEqual({
      kind: "stuck",
      device: "MacBook",
      failed: true,
    });
    const waiting = { ...stuck, stuck: stuck.stuck?.slice(0, 1) ?? [] };
    expect(syncLineOf(waiting, { replayShown: false })).toEqual({
      kind: "stuck",
      device: "iPad",
      failed: false,
    });
    const unnamed = { ...stuck, stuck: [{ device: "d4", kind: "waiting" as const, since: at }] };
    expect(syncLineOf(unnamed, { replayShown: false })).toEqual({ kind: "stuck", failed: false });
    const down = {
      ...ok,
      relay: { lastOk: at, lastError: "unavailable" as const, lastErrorAt: at + 9 },
    };
    expect(syncLineOf(down, { replayShown: false })).toEqual({ kind: "paused", since: at });
    expect(syncLineOf(ok, { replayShown: false })).toBeNull();
  });

  it("says nothing for a local-only vault or one a notice speaks for", () => {
    const local = { ...ok, remote: false, relay: { lastError: "quota" as const, lastErrorAt: at } };
    expect(syncLineOf(local, { replayShown: false })).toBeNull();
    expect(syncLineOf({ ...ok, phase: "removed" }, { replayShown: true })).toBeNull();
  });
});
