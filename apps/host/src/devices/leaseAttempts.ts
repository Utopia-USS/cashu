import { mintUlid, type Store } from "@cashu/store";
import { devices, ownBatchDigest, type SyncEngine, type UnstampedEvent } from "@cashu/sync";
import type { SqlAttemptJournal } from "../attemptJournal.js";
import { errorName } from "../log.js";
import type { WriteQueue } from "../queue.js";

const FETCH_REPORT_COMMAND = "native.devices.fetchReport";
export const LEADER_PIN_COMMAND = "native.devices.leaderPin";
const LEADER_RELEASE_COMMAND = "native.devices.leaderRelease";
const LEASE_COMMANDS = new Set([FETCH_REPORT_COMMAND, LEADER_PIN_COMMAND, LEADER_RELEASE_COMMAND]);
type LeaseOutcome = "completed" | "not_started" | "outcome_unknown";

interface LeaseAttemptInput {
  readonly vault: string;
  readonly identity: import("@cashu/sync").crypto.DeviceIdentity;
  readonly store: Store;
  readonly engine: SyncEngine;
  readonly authority: devices.VaultDevices;
  readonly attempts: SqlAttemptJournal;
  readonly queue: WriteQueue;
  readonly now: () => number;
  readonly current: () => boolean;
  readonly canFetch: () => boolean;
  readonly canPin: () => boolean;
  readonly canPinTarget: (leader: string, force: boolean) => boolean;
}

/** A lease append has its own durable receipt and cannot change an already-completed fetch. */
export function leaseAttempts(input: LeaseAttemptInput) {
  const reconcile = async (
    attemptId: string,
    eids: readonly string[],
    digest: string,
  ): Promise<LeaseOutcome> => {
    const proof = await input.engine.inspectOwnBatch({ eids, digest });
    if (proof === "committed") {
      await input.attempts.markCompleted(attemptId, { kind: "completed", operationId: attemptId });
      return "completed";
    }
    if (proof === "absent") {
      await input.attempts.markNotStarted(attemptId);
      return "not_started";
    }
    return "outcome_unknown";
  };
  const reconcilePending = async (): Promise<void> => {
    for (const pending of await input.attempts.unresolved(input.vault)) {
      if (!LEASE_COMMANDS.has(pending.commandId) || !pending.digest) continue;
      try {
        await reconcile(pending.attemptId, pending.eids, pending.digest);
      } catch (error) {
        console.warn("native_lease_reconcile_failed", errorName(error));
        // Ambiguous signed history remains inspectable by its original attempt ID.
      }
    }
  };
  const append = async (
    commandId: string,
    attemptId: string,
    event: UnstampedEvent,
    expectedHead: string | null,
  ): Promise<LeaseOutcome> => {
    if (input.attempts.hasPending(input.vault, commandId)) {
      await reconcilePending();
      if (input.attempts.hasPending(input.vault, commandId)) return "outcome_unknown";
    }
    const digest = ownBatchDigest([event]);
    const saved = await input.attempts.saveMayAppend({
      vault: input.vault,
      key: attemptId,
      attemptId,
      commandId,
      fingerprint: JSON.stringify({ head: expectedHead, digest }),
      eids: [attemptId],
      digest,
    });
    if (saved.phase !== "may_append" || saved.attemptId !== attemptId) return "outcome_unknown";
    try {
      await input.engine.write([event]);
      return await reconcile(attemptId, [attemptId], digest);
    } catch (error) {
      console.warn("native_lease_append_unknown", errorName(error));
      return "outcome_unknown";
    }
  };
  return {
    reconcilePending,
    inspect(commandId: string, attemptId: string): Promise<LeaseOutcome | "not_found"> {
      return input.queue.run(async () => {
        const status = input.attempts.status(input.vault, attemptId, commandId);
        if (status.phase === "absent") return "not_found";
        if (status.phase === "completed") return "completed";
        if (status.phase === "terminal") return "not_started";
        if (status.phase !== "may_append" || !status.digest) return "outcome_unknown";
        try {
          return await reconcile(attemptId, status.eids, status.digest);
        } catch (error) {
          console.warn("native_lease_inspect_unknown", errorName(error));
          return "outcome_unknown";
        }
      });
    },
    recordFetched(): Promise<LeaseOutcome> {
      return input.queue.run(async () => {
        if (!input.current() || !input.canFetch()) return "not_started";
        const attemptId = mintUlid(input.now());
        const head = input.authority.lease.head;
        const event = devices.leaseEventFor("fetched", input.authority.lease, {
          identity: input.identity,
          vaultId: input.vault,
          eid: attemptId,
          now: input.now(),
          applied: input.store.cursors(),
        });
        return append(FETCH_REPORT_COMMAND, attemptId, event, head);
      });
    },
    /** Called from the native sync queue after a fresh pull; never nests queue.run. */
    releasePendingInQueue(local: devices.LeaseLocal): Promise<LeaseOutcome> {
      if (
        !input.canPin() ||
        devices.nextLeaseStep(input.authority.lease, local, false).kind !== "release"
      )
        return Promise.resolve("not_started");
      const attemptId = mintUlid(input.now());
      const head = input.authority.lease.head;
      const event = devices.leaseEventFor("release", input.authority.lease, {
        identity: input.identity,
        vaultId: input.vault,
        eid: attemptId,
        now: input.now(),
        applied: input.store.cursors(),
      });
      return append(LEADER_RELEASE_COMMAND, attemptId, event, head);
    },
    pin(
      leader: string,
      force: boolean,
      confirmation: string,
      expectedHead: string | null,
      attemptId: string,
    ): Promise<LeaseOutcome> {
      return input.queue.run(async () => {
        if (
          !input.canPin() ||
          !input.canPinTarget(leader, force) ||
          input.authority.lease.head !== expectedHead ||
          (input.authority.lease.mode === "pinned" && input.authority.lease.pinned === leader) ||
          !input.authority.registry.isTrusted(leader) ||
          confirmation !== devices.pinConfirmationText("pinned", leader, force)
        )
          return "not_started";
        const event = devices.pinEventFor(
          input.authority.lease,
          {
            identity: input.identity,
            vaultId: input.vault,
            eid: attemptId,
            now: input.now(),
            applied: input.store.cursors(),
          },
          { mode: "pinned", leader, force, confirmation: { kind: "typed", text: confirmation } },
          { transport: input.engine.leaseTransport() },
        );
        return append(LEADER_PIN_COMMAND, attemptId, event, expectedHead);
      });
    },
  };
}
