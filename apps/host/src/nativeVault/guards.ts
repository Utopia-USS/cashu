// The admission predicates of a native vault session: whether it is still the current authority,
// may run side effects (writes, workspace files, external effects) or may fetch public market data.
import { devices } from "@cashu/sync";
import { assertReplayedDeviceAuthority } from "../sync/keys/deviceAuthority.js";
import { type NativeVaultContext, profileGid } from "./context.js";
import { onceWarner } from "./diagnostics.js";
import { REVOKE_COMMAND } from "./revokeIntent.js";

/**
 * Pull evidence older than this is refreshed before a leader action: half the lease's publish
 * deadline (lease.ts `holdsLease` needs a pull within the whole deadline), so work between the
 * refresh and the next authority check keeps the other half as margin.
 */
export const FETCH_PULL_REFRESH_MS = devices.DEFAULT_LEASE_CONFIG.publishDeadlineMs / 2;

export interface SessionGuards {
  isCurrent(): boolean;
  canRunSideEffects(): boolean;
  canFetchPublicMarket(): boolean;
  /**
   * The session is current and this device is the vault's named fetch leader, but its pull evidence
   * is missing or older than FETCH_PULL_REFRESH_MS: a sync pass is what it lacks.
   */
  fetchPullStale(): boolean;
  /** Holds fetch authority now, or would after the pull `fetchPullStale` asks for (status only). */
  mayObtainFetchAuthority(): boolean;
  /** A pending revocation or pairing, or a write gate that is not ready, blocks a new append. */
  writesBlocked(): boolean;
}

export function sessionGuards(context: NativeVaultContext): SessionGuards {
  const { entry, store, engine, candidate, attempts, pairingJournal, lease, state, now } = context;
  const warnOnce = onceWarner();
  const isCurrent = () => {
    if (!state.current || state.syncing || !lease.held) return false;
    try {
      assertReplayedDeviceAuthority(
        candidate,
        { complete: true, requiresViewRebuild: false, rolledBack: false },
        profileGid(store),
      );
      // A revocation or recovery cut requires the device rotation protocol before another write.
      if (candidate.devices.rotationNeeded() !== undefined) return false;
      return true;
    } catch (error) {
      warnOnce("native_vault_not_current", error);
      return false;
    }
  };
  const canRunSideEffects = () => {
    try {
      return (
        isCurrent() &&
        !attempts.hasPending(entry.vaultId, REVOKE_COMMAND) &&
        pairingJournal.pending(entry.vaultId).length === 0 &&
        engine.writeAdmission() === "ready"
      );
    } catch (error) {
      warnOnce("native_vault_side_effects_unavailable", error);
      return false;
    }
  };
  const pullEvidence = () =>
    engine.fetchLeaseEvidence(
      (writer) => !candidate.devices.registry.revoked.has(writer),
      (writer) => candidate.devices.registry.isTrusted(writer),
    );
  const canFetchPublicMarket = () => {
    if (!isCurrent() || engine.writeAdmission() !== "ready") return false;
    try {
      const transport = engine.leaseTransport();
      const evidence = pullEvidence();
      return devices.mayRunNewestDayImports(
        candidate.devices.lease,
        {
          me: entry.deviceId,
          now: now(),
          lastPullAt: evidence.lastPullAt,
          transport,
          own: () => undefined,
          firstSeen: (eid) => candidate.devices.firstSeen(eid),
          clockOk: evidence.clockOk,
        },
        store.cursors(),
      );
    } catch (error) {
      warnOnce("native_vault_market_fetch_unavailable", error);
      return false;
    }
  };
  const fetchPullStale = () => {
    if (!isCurrent() || engine.writeAdmission() !== "ready") return false;
    try {
      // Only the device the lease names may lead, so only it gains anything from a pull here. Any
      // other device learns a new pin from the pass that delivers it (carrier, pairing).
      const view = candidate.devices.lease;
      const named = view.mode === "pinned" ? view.pinned : view.holder;
      if (view.free || named !== entry.deviceId) return false;
      const { lastPullAt } = pullEvidence();
      const at = now();
      return lastPullAt === undefined || at < lastPullAt || at - lastPullAt > FETCH_PULL_REFRESH_MS;
    } catch (error) {
      warnOnce("native_vault_fetch_pull_unavailable", error);
      return false;
    }
  };
  const mayObtainFetchAuthority = () => canFetchPublicMarket() || fetchPullStale();
  const writesBlocked = () =>
    attempts.hasPending(entry.vaultId, REVOKE_COMMAND) ||
    pairingJournal.pending(entry.vaultId).length > 0 ||
    engine.writeAdmission() !== "ready";
  return {
    isCurrent,
    canRunSideEffects,
    canFetchPublicMarket,
    fetchPullStale,
    mayObtainFetchAuthority,
    writesBlocked,
  };
}
