// The admission predicates of a native vault session: whether it is still the current authority,
// may run side effects (writes, workspace files, external effects) or may fetch public market data.
import { devices } from "@cashu/sync";
import { assertReplayedDeviceAuthority } from "../sync/keys/deviceAuthority.js";
import { type NativeVaultContext, profileGid } from "./context.js";
import { onceWarner } from "./diagnostics.js";
import { REVOKE_COMMAND } from "./revokeIntent.js";

export interface SessionGuards {
  isCurrent(): boolean;
  canRunSideEffects(): boolean;
  canFetchPublicMarket(): boolean;
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
  const canFetchPublicMarket = () => {
    if (!isCurrent() || engine.writeAdmission() !== "ready") return false;
    try {
      const transport = engine.leaseTransport();
      const evidence = engine.fetchLeaseEvidence(
        (writer) => !candidate.devices.registry.revoked.has(writer),
        (writer) => candidate.devices.registry.isTrusted(writer),
      );
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
  const writesBlocked = () =>
    attempts.hasPending(entry.vaultId, REVOKE_COMMAND) ||
    pairingJournal.pending(entry.vaultId).length > 0 ||
    engine.writeAdmission() !== "ready";
  return { isCurrent, canRunSideEffects, canFetchPublicMarket, writesBlocked };
}
