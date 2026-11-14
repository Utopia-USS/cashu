// The admission predicates of a native vault session: whether it is still the current authority,
// may run side effects (writes, workspace files, external effects) or may fetch public market data.

import { assertReplayedDeviceAuthority } from "@cashu/store/sync";
import { devices, type PullStatus } from "@cashu/sync";
import { type NativeVaultContext, profileGid } from "./context.js";
import { onceWarner } from "./diagnostics.js";
import { REVOKE_COMMAND } from "./revokeIntent.js";

/**
 * Pull evidence older than this is refreshed before a leader action: half the lease's publish
 * deadline (lease.ts `holdsLease` needs a pull within the whole deadline), so work between the
 * refresh and the next authority check keeps the other half as margin.
 */
const FETCH_PULL_REFRESH_MS = devices.DEFAULT_LEASE_CONFIG.publishDeadlineMs / 2;

/**
 * Where this device stands with the fetch lease, apart from the authority check itself:
 * - `unavailable`: the session is not current (closed, syncing) or its write gate is not ready;
 * - `not_leader`: the lease names another device, or none;
 * - `handover_pending`: a hand-over to or from this device waits for the old leader's ACK;
 * - `clock_suspect`: this device's clock disagrees with its peers;
 * - `pull_stale`: the named leader, but its pull evidence is missing or older than
 *   FETCH_PULL_REFRESH_MS: a sync pass is the one thing it lacks;
 * - `pull_fresh`: the named leader with fresh evidence (any refusal left is the lease's own, such
 *   as the catch-up watermark).
 * A pass cannot fix the first four, so only `pull_stale` asks for one.
 */
export type FetchLeaseState =
  | "unavailable"
  | "not_leader"
  | "handover_pending"
  | "clock_suspect"
  | "pull_stale"
  | "pull_fresh";

export interface SessionGuards {
  isCurrent(): boolean;
  canRunSideEffects(): boolean;
  canFetchPublicMarket(): boolean;
  fetchLeaseState(): FetchLeaseState;
  /**
   * The fetch-paused state the owner sees (value-free): this device is the pinned fetch leader and is
   * refused only because the G2 offline bound ran out (lease.ts `offlinePullAt`): its passes since the
   * last complete pull missed only unreachable remotes (or it has none: sync off), another device could
   * lead, and the later of the last complete pull and the owner's acknowledgement ("keep fetching on
   * this Mac", the relay setting's `offlineLeadAckAt`) is older than OFFLINE_LEAD_MAX_MS or unknown. A
   * fresh complete pull or that acknowledgement clears it. The Devices screen shows it so that the bound never refuses silently.
   */
  offlineTooLong(): boolean;
  /**
   * The other device that could lead (registry: trusted, not revoked, not known as a phone), the lowest
   * id when there are several; undefined when none. Names the other Mac in the owner's override.
   */
  peerThatCouldLead(): string | undefined;
  /** A pending revocation or pairing, or a write gate that is not ready, blocks a new append. */
  writesBlocked(): boolean;
}

/**
 * The engine's `offline` pull status as the lease's `offlinePull` (D6); nothing otherwise. G2: with
 * the last complete pull (persisted across restarts, `SyncEngine.pullHistory`) and whether another
 * device could be pinned: any other trusted, non-revoked device of the registry (exactly the targets
 * `leaderPrepare` accepts) that the vault's relay membership does not know as a phone
 * (`devices.peerCouldLead`; the registry itself does not tell a phone from a Mac).
 */
function offlinePull(
  pull: PullStatus,
  lastCompleteAt: number | undefined,
  acknowledgedAt: number | undefined,
  peerCanLead: boolean,
): Pick<devices.LeaseLocal, "offlinePull"> {
  return pull.kind === "offline"
    ? {
        offlinePull: {
          since: pull.since,
          reachedAt: pull.reachedAt,
          ...(lastCompleteAt === undefined ? {} : { lastCompleteAt }),
          ...(acknowledgedAt === undefined ? {} : { acknowledgedAt }),
          peerCanLead,
        },
      }
    : {};
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
  const otherDevices = (): string[] => {
    const { registry } = candidate.devices;
    return [...registry.trusted.keys()].filter(
      (device) => device !== entry.deviceId && !registry.revoked.has(device),
    );
  };
  const roleOf = (device: string) => context.source.relayRole?.(entry, device);
  const peerCanLead = (): boolean => devices.peerCouldLead(otherDevices(), roleOf);
  const peerThatCouldLead = (): string | undefined =>
    otherDevices()
      .filter((device) => devices.peerCouldLead([device], roleOf))
      .sort()[0];
  // G2 override: the owner's acknowledgement only moves the start of the bound (lease.ts).
  const offlineOf = (pull: PullStatus) =>
    offlinePull(
      pull,
      engine.pullHistory().lastCompleteAt,
      context.source.offlineLeadAck?.(entry),
      peerCanLead(),
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
          ...offlineOf(evidence.pull),
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
  const fetchLeaseState = (): FetchLeaseState => {
    if (!isCurrent() || engine.writeAdmission() !== "ready") return "unavailable";
    try {
      // Only the device the lease names may lead, so only it gains anything from a pull here. Any
      // other device learns a new pin from the pass that delivers it (carrier, pairing).
      const view = candidate.devices.lease;
      const named = view.mode === "pinned" ? view.pinned : view.holder;
      if (view.free || named !== entry.deviceId) return "not_leader";
      // The old leader's ACK and a trustworthy clock come from peers, not from this device's pull.
      if (view.pendingFrom !== null) return "handover_pending";
      const evidence = pullEvidence();
      if (!evidence.clockOk) return "clock_suspect";
      // D6: in mode pinned a pass that missed only unreachable remotes is evidence too, within the
      // G2 bound (lease.ts `offlinePullAt`).
      const at = now();
      const offlineAt =
        view.mode === "pinned"
          ? devices.offlinePullAt(offlineOf(evidence.pull).offlinePull, at)
          : undefined;
      const lastPullAt =
        offlineAt === undefined
          ? evidence.lastPullAt
          : Math.max(evidence.lastPullAt ?? Number.NEGATIVE_INFINITY, offlineAt);
      return lastPullAt === undefined || at < lastPullAt || at - lastPullAt > FETCH_PULL_REFRESH_MS
        ? "pull_stale"
        : "pull_fresh";
    } catch (error) {
      warnOnce("native_vault_fetch_pull_unavailable", error);
      return "unavailable";
    }
  };
  const offlineTooLong = (): boolean => {
    if (!isCurrent() || engine.writeAdmission() !== "ready") return false;
    try {
      const view = candidate.devices.lease;
      if (
        view.mode !== "pinned" ||
        view.free ||
        view.pinned !== entry.deviceId ||
        view.pendingFrom !== null
      )
        return false;
      const evidence = pullEvidence();
      if (evidence.pull.kind !== "offline") return false;
      const at = now();
      const last = evidence.lastPullAt;
      if (
        last !== undefined &&
        last <= at &&
        at - last <= devices.DEFAULT_LEASE_CONFIG.publishDeadlineMs
      )
        return false;
      const offline = offlineOf(evidence.pull).offlinePull;
      return offline?.peerCanLead === true && devices.offlinePullAt(offline, at) === undefined;
    } catch (error) {
      warnOnce("native_vault_offline_bound_unavailable", error);
      return false;
    }
  };
  const writesBlocked = () =>
    attempts.hasPending(entry.vaultId, REVOKE_COMMAND) ||
    pairingJournal.pending(entry.vaultId).length > 0 ||
    engine.writeAdmission() !== "ready";
  return {
    isCurrent,
    canRunSideEffects,
    canFetchPublicMarket,
    fetchLeaseState,
    offlineTooLong,
    peerThatCouldLead,
    writesBlocked,
  };
}
