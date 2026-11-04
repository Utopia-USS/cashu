// Inbound fold and push on one vault, serialized with UI commands through the session queue. Any
// failure of a fold leaves this session non-current (fail closed): authority may have moved.
import { crypto, type SyncResult } from "@cashu/sync";
import type { leaseAttempts } from "../devices/leaseAttempts.js";
import { assertReplayedDeviceAuthority } from "../sync/keys/deviceAuthority.js";
import { failClosed, type NativeVaultContext, profileGid } from "./context.js";
import { warnCause } from "./diagnostics.js";
import type { SessionGuards } from "./guards.js";

export interface SyncControl {
  sync(): Promise<SyncResult>;
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
  const sync = () =>
    queue.run(async () => {
      if (!guards.isCurrent()) throw new Error("native_session_unavailable");
      state.syncing = true;
      try {
        const result = await engine.sync();
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
        await crypto.saveKeyring(source.keyStore, candidate.ring);
        state.syncing = false;
        if (!guards.isCurrent()) throw new Error("native_authority_changed");
        notifySyncSettled();
        return result;
      } catch (error) {
        warnCause("native_sync_failed", error);
        state.current = false;
        state.syncing = false;
        notifySyncSettled();
        throw new Error("native_sync_unavailable");
      }
    });
  return {
    sync,
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
