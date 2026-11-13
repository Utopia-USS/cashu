// Inbound fold and push on one vault, serialized with UI commands through the session queue. Any
// failure of a fold leaves this session non-current (fail closed): authority may have moved. The one
// exception is a pass this device ran only to refresh its fetch-lease pull evidence: when the pass
// itself or the keyring save failed, but a fresh authenticated replay of the local log shows the
// same device authority, the session stays current (the refresh just produced no evidence).

import { assertReplayedDeviceAuthority } from "@cashu/store/sync";
import { crypto, type SyncResult } from "@cashu/sync";
import type { leaseAttempts } from "../devices/leaseAttempts.js";
import { failClosed, type NativeVaultContext, profileGid } from "./context.js";
import { warnCause } from "./diagnostics.js";
import type { SessionGuards } from "./guards.js";

/** A refresh pass failed; the session was verified and stays current (no evidence was produced). */
export const REFRESH_PASS_FAILED = "native_fetch_pull_failed";

export interface SyncControl {
  sync(): Promise<SyncResult>;
  /**
   * The same pass for a fetch-lease pull refresh (nativeVault/fetchAuthority.ts): a failure of the
   * engine pass or the keyring save that leaves the replayed authority unchanged rejects with
   * REFRESH_PASS_FAILED and keeps the session; an authority failure closes it like `sync()`.
   */
  refreshPass(): Promise<SyncResult>;
  isSyncing(): boolean;
  onSyncSettled(listener: () => void): () => void;
  /** Tells subscribers the session's sync state settled (also on invalidation). */
  notifySyncSettled(): void;
}

export function syncControl(
  context: NativeVaultContext,
  guards: Pick<SessionGuards, "isCurrent">,
  leaseReports: ReturnType<typeof leaseAttempts>,
): SyncControl {
  const { entry, store, engine, candidate, source, queue, state, now } = context;
  const listeners = new Set<() => void>();
  const notifySyncSettled = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        // One subscriber cannot change sync authority.
        warnCause("native_sync_listener_failed", error);
      }
    }
  };
  /** After a failed refresh pass: the local log replays completely to the same device authority. */
  const verifiedAfterFailure = async (): Promise<boolean> => {
    try {
      const recovered = await engine.recoverLocal();
      if (!recovered.complete || recovered.rolledBack) return false;
      assertReplayedDeviceAuthority(candidate, recovered, profileGid(store));
      if (candidate.devices.rotationNeeded() !== undefined) return false;
      state.syncing = false;
      return guards.isCurrent();
    } catch (error) {
      warnCause("native_refresh_verify_failed", error);
      return false;
    }
  };
  const pass = (refresh: boolean) =>
    queue.run(async () => {
      if (!guards.isCurrent()) throw new Error("native_session_unavailable");
      state.syncing = true;
      // Which step failed decides whether a refresh pass may keep the session: the engine pass and
      // the keyring save may, every authority check never does.
      let step: "pass" | "authority" | "keyring" = "pass";
      try {
        const result = await engine.sync();
        step = "authority";
        const recovery = await engine.recoverLocal();
        assertReplayedDeviceAuthority(candidate, recovery, profileGid(store));
        if (result.rolledBack || candidate.devices.rotationNeeded() !== undefined)
          throw new Error("native_authority_changed");
        if (candidate.devices.lease.pendingFrom === entry.deviceId && state.activeFetches === 0) {
          const evidence = engine.fetchLeaseEvidence(
            (writer) => !candidate.devices.registry.revoked.has(writer),
            (writer) => candidate.devices.registry.isTrusted(writer),
          );
          const release = await leaseReports.releasePendingInQueue({
            me: entry.deviceId,
            now: now(),
            lastPullAt: evidence.lastPullAt,
            transport: engine.leaseTransport(),
            own: () => undefined,
            firstSeen: (eid) => candidate.devices.firstSeen(eid),
            clockOk: evidence.clockOk,
          });
          if (release === "outcome_unknown") throw new Error("native_lease_release_uncertain");
        }
        // The gate may have accepted a new wrapped generation during this sync.
        step = "keyring";
        await crypto.saveKeyring(source.keyStore, candidate.ring);
        step = "authority";
        state.syncing = false;
        if (!guards.isCurrent()) throw new Error("native_authority_changed");
        notifySyncSettled();
        return result;
      } catch (error) {
        warnCause("native_sync_failed", error);
        if (refresh && step !== "authority" && state.current && (await verifiedAfterFailure())) {
          state.syncing = false;
          notifySyncSettled();
          throw new Error(REFRESH_PASS_FAILED);
        }
        state.current = false;
        state.syncing = false;
        notifySyncSettled();
        throw new Error("native_sync_unavailable");
      }
    });
  const sync = () => pass(false);
  return {
    sync,
    refreshPass: () => pass(true),
    isSyncing: () => state.syncing,
    onSyncSettled(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notifySyncSettled,
  };
}

/**
 * Inside the queue, before a device revocation is previewed or cut: pulls and replays inbound
 * history and checks this device's authority. Any failure closes the session and returns false.
 */
export async function foldBeforeRevocation(
  context: NativeVaultContext,
  event: string,
): Promise<boolean> {
  const { store, engine, candidate } = context;
  try {
    const synced = await engine.sync();
    const recovered = await engine.recoverLocal();
    if (synced.rolledBack || !recovered.complete || recovered.rolledBack)
      throw new Error("sync_incomplete");
    assertReplayedDeviceAuthority(candidate, recovered, profileGid(store));
    return true;
  } catch (error) {
    warnCause(event, error);
    failClosed(context);
    return false;
  }
}
