// Device revocation with the recovery authority: preview, the keyed commit (rotation + revoke batch
// under a durable may-append intent) and inspection of an earlier operation.
import { mintUlid } from "@cashu/store";
import { crypto, devices, ownBatchDigest } from "@cashu/sync";
import { failClosed, type NativeVaultContext } from "./context.js";
import { warnCause } from "./diagnostics.js";
import type { SessionGuards } from "./guards.js";
import { reconcileRevoke } from "./recovery.js";
import { REVOKE_COMMAND } from "./revokeIntent.js";
import { foldBeforeRevocation } from "./sync.js";
import type { NativeDeviceRevokeDraft, NativeVaultSession } from "./types.js";

type Revocation = Pick<NativeVaultSession, "devicePreview" | "deviceCommit" | "deviceInspect">;

export function revocation(
  context: NativeVaultContext,
  guards: Pick<SessionGuards, "isCurrent">,
): Revocation {
  const { entry, store, engine, candidate, attempts, source, queue, now } = context;
  const revokeRequest = (draft: NativeDeviceRevokeDraft): devices.RevocationPreviewRequest => {
    const view = store.cursors();
    const guarded = new Map(candidate.devices.guard.entries());
    return {
      targets: draft.targets.map((device) => {
        const applied = guarded.get(device) ?? { seg: 1, offset: 0 };
        const durable = view.get(device) ?? { seg: 1, offset: 0 };
        if (applied.seg !== durable.seg || applied.offset !== durable.offset)
          throw new Error("revoke_cursor_mismatch");
        return { device, applied };
      }),
      revokeEid: draft.eids.revoke,
      attemptId: draft.operationId,
      authority: { kind: "recovery" },
      selection: { recertify: draft.recertify },
    };
  };
  /** The request, or undefined when the view and the gate disagree on a target's cursor. */
  const checkedRequest = (
    draft: NativeDeviceRevokeDraft,
    event: string,
  ): devices.RevocationPreviewRequest | undefined => {
    try {
      return revokeRequest(draft);
    } catch (error) {
      warnCause(event, error);
      return undefined;
    }
  };

  const devicePreview: Revocation["devicePreview"] = (draft) =>
    queue.run(async () => {
      if (!guards.isCurrent() || draft.vault !== entry.vaultId)
        return { kind: "refused", code: "unavailable" } as const;
      if (attempts.hasPending(entry.vaultId, REVOKE_COMMAND))
        return { kind: "refused", code: "outcome_unknown" } as const;
      if (draft.targets.includes(entry.deviceId))
        return { kind: "refused", code: "retirement_unavailable" } as const;
      if (!(await foldBeforeRevocation(context, "native_device_preview_fold_failed")))
        return { kind: "refused", code: "unavailable" } as const;
      const request = checkedRequest(draft, "native_device_preview_integrity");
      if (request === undefined) return { kind: "refused", code: "integrity_failure" } as const;
      const observed = devices.previewRevocation(candidate.devices, candidate.gate, request);
      if (!observed.ok)
        return {
          kind: "refused",
          code: observed.reason === "integrity_error" ? "integrity_failure" : "unsafe_target",
        } as const;
      const preview = observed.preview;
      const after = candidate.devices.registry.previewRevocation(draft.targets);
      const affected = [...candidate.devices.registry.trusted.keys()]
        .filter((id) => !draft.targets.includes(id) && !after.trusted.has(id))
        .sort()
        .map((device) => ({
          device,
          name: candidate.devices.registry.devices.get(device)?.name ?? "device",
          selected: draft.recertify.includes(device),
        }));
      return {
        kind: "prepared",
        fingerprint: preview.fingerprint,
        targets: preview.targets.map((target) => ({
          device: target.entry.device,
          cut: target.entry.cut,
          head: target.status === "trusted_head" ? "trusted" : "local_start",
        })),
        affected,
        localStartConfirmationRequired: preview.requiresLocalStartConfirmation,
      } as const;
    });

  const deviceCommit: Revocation["deviceCommit"] = (draft, input) =>
    queue.run(async () => {
      if (!guards.isCurrent() || draft.vault !== entry.vaultId || !draft.fingerprint)
        return { kind: "refused", code: "unavailable" } as const;
      if (attempts.hasPending(entry.vaultId, REVOKE_COMMAND))
        return { kind: "refused", code: "outcome_unknown" } as const;
      const existing = candidate.devices.registry.isTrusted(entry.deviceId);
      if (draft.targets.includes(entry.deviceId))
        return { kind: "refused", code: "retirement_unavailable" } as const;
      if (!existing) return { kind: "refused", code: "unsafe_target" } as const;
      // Reconcile inbound history before the final local cut. The queue holds every local writer.
      if (!(await foldBeforeRevocation(context, "native_device_commit_fold_failed")))
        return { kind: "refused", code: "unavailable" } as const;
      const request = checkedRequest(draft, "native_device_commit_integrity");
      if (request === undefined) return { kind: "refused", code: "integrity_failure" } as const;
      const observed = devices.previewRevocation(candidate.devices, candidate.gate, request);
      if (!observed.ok)
        return {
          kind: "refused",
          code: observed.reason === "integrity_error" ? "integrity_failure" : "preview_stale",
        } as const;
      if (observed.preview.fingerprint !== draft.fingerprint)
        return { kind: "refused", code: "preview_stale" } as const;
      const permit = devices.acknowledgeRevocationPreview(observed.preview, {
        warning: "acknowledged",
        ...(input.localStartAcknowledgement === "local_target_stream_never_seen"
          ? { localStart: "local_never_seen" as const }
          : {}),
      });
      if (!permit) return { kind: "refused", code: "confirmation_required" } as const;
      let recovery: crypto.RecoveryIdentity;
      try {
        recovery = crypto.recoveryIdentity(source.sodium, input.recoveryPhrase);
      } catch (error) {
        // A mistyped phrase is the expected refusal; anything else is worth a trace.
        if (!(error instanceof crypto.CryptoError && error.code === "bad_mnemonic"))
          warnCause("native_device_commit_recovery_failed", error);
        return { kind: "refused", code: "recovery_invalid" } as const;
      }
      let prepared: devices.PrepareResult | undefined;
      let intentStarted = false;
      try {
        const recertifyEids = draft.recertify.map(() => mintUlid(now()));
        let next = 0;
        prepared = candidate.devices.prepareRevocation(
          candidate.gate,
          request,
          permit,
          { ...draft.eids, recertify: () => recertifyEids[next++] ?? mintUlid(now()) },
          recovery,
          { recertify: draft.recertify },
        );
        if (!prepared.ok)
          return {
            kind: "refused",
            code: prepared.reason === "authority_required" ? "authority_required" : "unsafe_target",
          } as const;
        if (
          draft.recertify.some(
            (device) =>
              !prepared?.ok ||
              !prepared.change.affected.some(
                (affected) => affected.device === device && affected.recertified,
              ),
          )
        ) {
          prepared.change.discard();
          return { kind: "refused", code: "recertify_capacity" } as const;
        }
        const change = prepared.change;
        const rotated = change.key;
        if (!rotated) {
          change.discard();
          return { kind: "refused", code: "unsafe_target" } as const;
        }
        const eids = change.events.map((event) => event.i);
        const digest = ownBatchDigest(change.events);
        const fingerprint = JSON.stringify({
          preview: observed.preview.fingerprint,
          digest,
          key: change.key,
        });
        intentStarted = true;
        const saved = await attempts.saveMayAppend({
          vault: entry.vaultId,
          key: draft.operationId,
          attemptId: draft.operationId,
          commandId: REVOKE_COMMAND,
          fingerprint,
          eids,
          digest,
        });
        if (
          saved.phase !== "may_append" ||
          saved.attemptId !== draft.operationId ||
          saved.fingerprint !== fingerprint ||
          saved.eids.join("|") !== eids.join("|")
        ) {
          change.discard();
          failClosed(context);
          return { kind: "outcome_unknown", operationId: draft.operationId } as const;
        }
        try {
          await engine.write(change.events);
          const verified = await engine.inspectOwnBatch({ eids, digest });
          if (verified !== "committed") throw new Error("revoke_history_unverified");
          const replayed = candidate.ring.get(rotated.kid);
          if (
            !replayed ||
            replayed.generation !== rotated.generation ||
            replayed.epoch !== rotated.epoch
          )
            throw new Error("revoke_self_wrap_unavailable");
          change.commit();
          await crypto.saveKeyring(source.keyStore, candidate.ring);
          await attempts.markCompleted(draft.operationId, {
            kind: "completed",
            operationId: draft.operationId,
          });
          return { kind: "completed", operationId: draft.operationId } as const;
        } catch (error) {
          warnCause("native_device_commit_append_unknown", error);
          failClosed(context);
          return { kind: "outcome_unknown", operationId: draft.operationId } as const;
        }
      } catch (error) {
        warnCause(
          intentStarted ? "native_device_commit_intent_unknown" : "native_device_commit_refused",
          error,
        );
        if (intentStarted) {
          failClosed(context);
          return { kind: "outcome_unknown", operationId: draft.operationId } as const;
        }
        return { kind: "refused", code: "unsafe_target" } as const;
      } finally {
        recovery.wipe();
        if (prepared?.ok) prepared.change.discard();
      }
    });

  const deviceInspect: Revocation["deviceInspect"] = (operationId) =>
    queue.run(async () => {
      const status = attempts.status(entry.vaultId, operationId, REVOKE_COMMAND);
      if (status.phase === "absent") return { kind: "not_found", operationId } as const;
      if (status.phase === "completed") return { kind: "completed", operationId } as const;
      if (status.phase === "terminal" && status.result.kind === "not_started")
        return { kind: "not_started", operationId } as const;
      if (status.phase !== "may_append")
        return { kind: "refused", code: "operation_conflict" } as const;
      // Inspection only reconciles the original keyed operation. It never creates a new batch.
      const result = await reconcileRevoke(context, operationId, status.eids, status.fingerprint);
      return { kind: result, operationId } as const;
    });

  return { devicePreview, deviceCommit, deviceInspect };
}
