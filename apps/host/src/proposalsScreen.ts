import { runCommand, v1 } from "@cashu/store";
import {
  type ApprovalPublication,
  type ExecutionSnapshot,
  executePreparedApproval,
  type PreparedEffect,
  ProposalApplyingLock,
  type ProposalLock,
  proposalExecution,
  rejectProposal,
} from "@cashu/store/core";
import type { UiActionResult } from "@cashu/store/ui-actions";
import { z } from "zod";
import type { HostStores } from "./stores.js";
import type { UiActionRegistration } from "./uiActions.js";

const input = z.object({ gid: v1.gid, decision: z.enum(["approve", "reject"]) });

/** A checked per-vault S60 source. No renderer-supplied file paths, effects or holder assertions. */
interface ProposalApprovalBinding {
  readonly generation: string;
  readonly dailyLock: ProposalLock;
  isCurrent(): boolean;
  isHolder(): boolean;
  /** Read-only preparation. Staging/publication begins only inside the S60 publication lifecycle. */
  prepare(snapshot: ExecutionSnapshot): Promise<{
    readonly effect: PreparedEffect<unknown>;
    readonly publication?: ApprovalPublication<unknown>;
  }>;
}

export interface ProposalApprovalProvider {
  bind(vault: string): ProposalApprovalBinding | null;
}

/** Serializes reject with applying approval; returns the executor's actual business outcome. */
export function proposalScreen(provider?: ProposalApprovalProvider): UiActionRegistration {
  const applyingLock = new ProposalApplyingLock();
  return {
    id: "core.desktopProposals.review",
    async run(stores: HostStores, target: string, raw: unknown, sessionCurrent = () => true) {
      const parsed = input.safeParse(raw);
      if (!parsed.success)
        return { status: "refused", reason: "invalid_input", preparation: "none" };
      const vault = stores.vaults.get(target);
      if (!vault) return { status: "refused", reason: "unknown_target", preparation: "none" };
      const current = () => sessionCurrent() && stores.vaults.get(target) === vault;
      const snapshot = proposalExecution(vault.store.read.bind(vault.store), parsed.data.gid);
      if (!snapshot) return { status: "refused", reason: "not_found", preparation: "none" };
      if (snapshot.status !== "pending")
        return { status: "refused", reason: "not_pending", preparation: "none" };
      if (parsed.data.decision === "reject") {
        const release = applyingLock.tryAcquire(target);
        if (!release) return { status: "refused", reason: "busy", preparation: "none" };
        try {
          const result = await vault.queue.run(() =>
            current()
              ? runCommand(
                  vault.store,
                  vault.writer,
                  rejectProposal,
                  {
                    proposalGid: parsed.data.gid,
                    note: null,
                  },
                  vault.env,
                )
              : ({ ok: false, reason: "authority_lost" } as const),
          );
          if (!result.ok) return { status: "refused", reason: result.reason, preparation: "none" };
          return {
            status: "completed",
            value: { status: "rejected", proposalGid: parsed.data.gid },
          };
        } finally {
          release();
        }
      }
      const binding = provider?.bind(target);
      if (!binding?.isCurrent())
        return { status: "refused", reason: "capability_unavailable", preparation: "none" };
      const bound = () =>
        current() &&
        provider?.bind(target)?.generation === binding.generation &&
        binding.isCurrent();
      if (!bound()) return { status: "refused", reason: "authority_lost", preparation: "none" };
      let prepared: Awaited<ReturnType<ProposalApprovalBinding["prepare"]>>;
      try {
        prepared = await binding.prepare(snapshot);
      } catch {
        return { status: "refused", reason: "preparation_failed", preparation: "none" };
      }
      if (prepared.effect.proposalGid !== snapshot.gid || prepared.effect.kind !== snapshot.kind)
        return { status: "refused", reason: "wrong_preparation", preparation: "retained" };
      if (!bound()) return { status: "refused", reason: "authority_lost", preparation: "retained" };
      const outcome = await executePreparedApproval(
        {
          store: vault.store,
          writer: vault.writer,
          env: vault.env,
          dailyLock: binding.dailyLock,
          applyingLock,
          runWrite: (work) => vault.queue.run(work),
          isVaultCurrent: bound,
          isHolder: () => bound() && binding.isHolder(),
        },
        prepared.effect,
        prepared.publication,
      );
      return { status: "completed", value: outcome } satisfies UiActionResult<typeof outcome>;
    },
  };
}
