// The device list of a vault (registry, gate evidence, leader liveness, key provenance) and the
// preparation of a leader pin. The pin itself is a lease attempt (devices/leaseAttempts).
import { devices } from "@cashu/sync";
import { LEADER_PIN_COMMAND } from "../devices/leaseAttempts.js";
import type { NativeVaultContext } from "./context.js";
import type { SessionGuards } from "./guards.js";
import { REVOKE_COMMAND } from "./revokeIntent.js";
import type { NativeVaultSession } from "./types.js";

type DeviceReads = Pick<NativeVaultSession, "deviceList" | "leaderPrepare">;

export function deviceReads(
  context: NativeVaultContext,
  guards: Pick<
    SessionGuards,
    | "isCurrent"
    | "canRunSideEffects"
    | "canFetchPublicMarket"
    | "offlineTooLong"
    | "peerThatCouldLead"
  >,
): DeviceReads {
  const { entry, engine, candidate, attempts, provenance, queue, state, now } = context;
  const deviceList: DeviceReads["deviceList"] = () =>
    queue.run(() => {
      if (!guards.isCurrent()) return { kind: "refused", code: "unavailable" } as const;
      const behind = new Set(candidate.gate.behind().map((x) => x.device));
      const forked = new Map(candidate.gate.forks().map((x) => [x.device, x.agreed]));
      const liveness = devices.leaderLiveness(candidate.devices.lease, candidate.devices.registry, {
        now: now(),
        firstSeen: (eid) => candidate.devices.firstSeen(eid),
      });
      const activeProvenance = provenance.get(candidate.ring.active.kid);
      const paused = guards.offlineTooLong();
      const pausedPeer = paused ? guards.peerThatCouldLead() : undefined;
      const records = [...candidate.devices.registry.devices.values()].sort((a, b) =>
        a.deviceId.localeCompare(b.deviceId),
      );
      return {
        kind: "ready",
        vault: entry.vaultId,
        ownDevice: entry.deviceId,
        operations: [...attempts.recentOperations(entry.vaultId, REVOKE_COMMAND)],
        leaderOperations: [...attempts.recentOperations(entry.vaultId, LEADER_PIN_COMMAND)],
        evidence: {
          historyPending: candidate.gate.gossipStatus().historyPending,
          overflow: candidate.gate.gossipStatus().overflow,
          authorityUncertain: candidate.gate.gossipStatus().authorityUncertain,
          writeAdmission: engine.writeAdmission(),
        },
        leader: {
          mode: liveness.mode,
          state: liveness.state,
          device: liveness.leader,
          pendingFrom: liveness.pendingFrom,
          lastActivityAt: liveness.lastActivityAt ?? null,
          silentForMs: liveness.silentForMs,
          warn: liveness.warn,
          // The G2 offline bound refuses this pinned leader: shown, never silent.
          ...(paused ? { paused: "offline_too_long" as const } : {}),
          ...(pausedPeer === undefined ? {} : { pausedPeer }),
        },
        keyProvenance: {
          source: activeProvenance?.source ?? "unknown",
          sender:
            activeProvenance?.sender && /^[0-9a-f]{32}$/.test(activeProvenance.sender)
              ? activeProvenance.sender
              : null,
          recipientsKnown:
            activeProvenance?.recipients !== null && activeProvenance?.recipients !== undefined,
        },
        devices: records.map((record) => ({
          id: record.deviceId,
          name: record.name,
          trusted: candidate.devices.registry.isTrusted(record.deviceId),
          revoked: candidate.devices.registry.revoked.has(record.deviceId),
          behind: behind.has(record.deviceId),
          forked: forked.has(record.deviceId),
          forkAgreed: forked.get(record.deviceId) ?? null,
          pairedBy: record.pairedBy,
          pairedAt: record.pairedAt.position,
        })),
      } as const;
    });
  const leaderPrepare: DeviceReads["leaderPrepare"] = (leader, force) =>
    queue.run(() => {
      if (
        !guards.canRunSideEffects() ||
        (candidate.devices.lease.mode === "pinned" && candidate.devices.lease.pinned === leader) ||
        !candidate.devices.registry.isTrusted(leader) ||
        candidate.devices.registry.revoked.has(leader)
      )
        return { kind: "refused", code: "unsafe_target" } as const;
      if (
        !force &&
        leader !== entry.deviceId &&
        candidate.devices.lease.holder === entry.deviceId &&
        (state.activeFetches > 0 || !guards.canFetchPublicMarket())
      )
        return { kind: "refused", code: "unavailable" } as const;
      const head = candidate.devices.lease.head;
      if (head === null) return { kind: "refused", code: "unavailable" } as const;
      const liveness = devices.leaderLiveness(candidate.devices.lease, candidate.devices.registry, {
        now: now(),
        firstSeen: (eid) => candidate.devices.firstSeen(eid),
      });
      return {
        kind: "prepared",
        head,
        mayStillRun: liveness.repin?.mayStillRun ?? null,
        confirmationText: devices.pinConfirmationText("pinned", leader, force),
      } as const;
    });
  return { deviceList, leaderPrepare };
}
