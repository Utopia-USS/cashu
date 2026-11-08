// Reconciling keyed attempts against the authenticated log: at open (every unresolved revocation,
// then every completed attempt's history) and when a revocation is inspected later.
import { crypto } from "@cashu/sync";
import { isLeaseCommand } from "../devices/leaseAttempts.js";
import type { NativeVaultContext } from "./context.js";
import { warnCause } from "./diagnostics.js";
import { parseRevokeIntentProof, REVOKE_COMMAND } from "./revokeIntent.js";

type RevokeOutcome = "completed" | "not_started" | "outcome_unknown";

/**
 * Settles one revocation attempt from its own intent proof. Anything ambiguous leaves the original
 * keyed attempt pending (`outcome_unknown`) until the same proof can be inspected again.
 */
export async function reconcileRevoke(
  context: NativeVaultContext,
  operationId: string,
  eids: readonly string[],
  fingerprint: string,
): Promise<RevokeOutcome> {
  const { engine, candidate, attempts, source } = context;
  try {
    const proof = parseRevokeIntentProof(fingerprint);
    const verified = await engine.inspectOwnBatch({ eids, digest: proof.digest });
    const held = candidate.ring.get(proof.key.kid);
    if (
      verified === "committed" &&
      held &&
      held.generation === proof.key.generation &&
      held.epoch === proof.key.epoch
    ) {
      await crypto.saveKeyring(source.keyStore, candidate.ring);
      await attempts.markCompleted(operationId, { kind: "completed", operationId });
      return "completed";
    }
    if (verified === "absent") {
      await attempts.markNotStarted(operationId);
      return "not_started";
    }
  } catch (error) {
    warnCause("native_revoke_reconcile_unknown", error);
  }
  return "outcome_unknown";
}

/**
 * At open. The original EIDs of confirmed attempts must remain in recovered authenticated history;
 * an EID alone never promotes an unknown attempt to semantic success.
 */
export async function reconcileAttemptHistory(context: NativeVaultContext): Promise<void> {
  const { entry, meta, engine, store, candidate, attempts } = context;
  for (const record of await attempts.unresolved(entry.vaultId)) {
    if (record.commandId === REVOKE_COMMAND)
      await reconcileRevoke(context, record.attemptId, record.eids, record.fingerprint);
  }
  const completed = meta
    .prepare(
      "SELECT command_id, fingerprint, eids, digest FROM host_attempts WHERE phase='completed'",
    )
    .all<{ command_id: string; fingerprint: string; eids: string; digest: string | null }>();
  for (const row of completed) {
    const eids: unknown = JSON.parse(row.eids);
    if (!Array.isArray(eids) || !eids.every((eid) => typeof eid === "string"))
      throw new Error("corrupt_attempt");
    if (row.command_id === REVOKE_COMMAND) {
      const proof = parseRevokeIntentProof(row.fingerprint);
      const result = await engine.inspectOwnBatch({ eids, digest: proof.digest });
      const held = candidate.ring.get(proof.key.kid);
      if (
        result !== "committed" ||
        !held ||
        held.generation !== proof.key.generation ||
        held.epoch !== proof.key.epoch
      )
        throw new Error("incomplete_history");
    } else if (isLeaseCommand(row.command_id)) {
      // Lease events (a fetch report, a pin, a release) live in the device layer of this device's
      // own log, not in the store's event log: prove them by the own-log batch digest.
      if (row.digest === null) throw new Error("corrupt_attempt");
      if ((await engine.inspectOwnBatch({ eids, digest: row.digest })) !== "committed")
        throw new Error("incomplete_history");
    } else if (store.eventHlcs(eids).size !== eids.length) {
      throw new Error("incomplete_history");
    }
  }
}
