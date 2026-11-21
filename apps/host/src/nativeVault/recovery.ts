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
  // Every own-log proof is collected first and checked in ONE engine pass (one recovery, one read of
  // the own log): one pass per attempt made each open grow with the log times the attempts. Rows are
  // then judged in order as before; a row that cannot be read stops the collection, and its error is
  // thrown after the rows before it are judged, exactly as before.
  type Row = { readonly eids: readonly string[] } & (
    | { readonly kind: "revoke"; readonly proof: ReturnType<typeof parseRevokeIntentProof> }
    | { readonly kind: "lease"; readonly digest: string }
    | { readonly kind: "store" }
    | { readonly kind: "fails"; readonly error: unknown }
  );
  const rows: Row[] = [];
  for (const row of completed) {
    const eids: unknown = JSON.parse(row.eids);
    if (!Array.isArray(eids) || !eids.every((eid) => typeof eid === "string")) {
      rows.push({ kind: "fails", eids: [], error: new Error("corrupt_attempt") });
      break;
    }
    if (row.command_id === REVOKE_COMMAND) {
      let proof: ReturnType<typeof parseRevokeIntentProof>;
      try {
        proof = parseRevokeIntentProof(row.fingerprint);
      } catch (error) {
        rows.push({ kind: "fails", eids: [], error });
        break;
      }
      rows.push({ kind: "revoke", eids, proof });
    } else if (isLeaseCommand(row.command_id)) {
      // Lease events (a fetch report, a pin, a release) live in the device layer of this device's
      // own log, not in the store's event log: prove them by the own-log batch digest.
      if (row.digest === null) {
        rows.push({ kind: "fails", eids: [], error: new Error("corrupt_attempt") });
        break;
      }
      rows.push({ kind: "lease", eids, digest: row.digest });
    } else rows.push({ kind: "store", eids });
  }
  const proved = rows.flatMap((row) =>
    row.kind === "revoke"
      ? [{ eids: row.eids, digest: row.proof.digest }]
      : row.kind === "lease"
        ? [{ eids: row.eids, digest: row.digest }]
        : [],
  );
  const verdicts = proved.length === 0 ? [] : await engine.inspectOwnBatches(proved);
  let next = 0;
  for (const row of rows) {
    if (row.kind === "fails") throw row.error;
    if (row.kind === "store") {
      if (store.eventHlcs(row.eids).size !== row.eids.length) throw new Error("incomplete_history");
      continue;
    }
    const result = verdicts[next++];
    if (row.kind === "revoke") {
      const held = candidate.ring.get(row.proof.key.kid);
      if (
        result !== "committed" ||
        !held ||
        held.generation !== row.proof.key.generation ||
        held.epoch !== row.proof.key.epoch
      )
        throw new Error("incomplete_history");
    } else if (result !== "committed") throw new Error("incomplete_history");
  }
}
