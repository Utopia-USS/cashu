import { randomUUID } from "node:crypto";
import { type Command, mintUlid, refuse, v1 } from "@cashu/store";
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
import { StrategyProposalError } from "@cashu/store/investments/services";
import type { UiActionResult } from "@cashu/store/ui-actions";
import { z } from "zod";
import { runHostVaultCommand } from "./commands.js";
import type { HostStores } from "./stores.js";
import { type UiActionRegistration, unknownUiCommand } from "./uiActions.js";

const input = z.object({ gid: v1.gid, decision: z.enum(["approve", "reject"]) });
const approvalIntent = z.strictObject({ proposalGid: v1.gid, preparationId: z.uuid() });

/** Bind closure-captured approval semantics to the parsed durable fingerprint. */
export function bindApprovalIntent<I, R>(
  command: Command<I, R>,
  value: I,
  proposalGid: string,
  preparationId: string,
): { command: Command<z.infer<typeof approvalIntent>, R>; input: z.infer<typeof approvalIntent> } {
  return {
    command: {
      id: command.id,
      input: approvalIntent,
      run(ctx, intent) {
        if (intent.proposalGid !== proposalGid || intent.preparationId !== preparationId)
          return refuse("wrong_preparation");
        return command.run(ctx, value);
      },
    },
    input: { proposalGid, preparationId },
  };
}

/**
 * Strategy and custom-rule refusals the owner can act on (Python `proposals.approve` returned the
 * code and the app showed its label): the strategy files changed, the rule already exists or is
 * invalid, the files are missing or unreadable, or the result would not validate. Anything else
 * (lost authority, a changed proposal, an internal failure) stays `preparation_failed`.
 */
const STRATEGY_REFUSALS: ReadonlySet<string> = new Set([
  "busy",
  "base_changed",
  "rule_exists",
  "rule_invalid",
  "strategy_missing",
  "strategy_unreadable",
  "invalid_strategy",
  "rules_made_inactive",
]);

function preparationRefusal(error: unknown): string {
  return error instanceof StrategyProposalError && STRATEGY_REFUSALS.has(error.code)
    ? error.code
    : "preparation_failed";
}

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
  bind(vault: string, stores: HostStores): ProposalApprovalBinding | null;
}

/** Serializes reject with applying approval; returns the executor's actual business outcome.
 * Strategy and custom-rule proposals approve through `strategies`, every other kind through
 * `provider` (imports). */
export function proposalScreen(
  provider?: ProposalApprovalProvider,
  strategies?: ProposalApprovalProvider,
): UiActionRegistration {
  const applyingLock = new ProposalApplyingLock();
  // A pending approval may still publish files, so another proposal cannot overlap it.
  const unresolved = new Map<string, { identity: string; result: UiActionResult<unknown> }>();
  const preparationIds = new WeakMap<PreparedEffect<unknown>, string>();
  return {
    id: "core.desktopProposals.review",
    async run(stores: HostStores, target: string, raw: unknown, sessionCurrent = () => true) {
      const parsed = input.safeParse(raw);
      if (!parsed.success)
        return { status: "refused", reason: "invalid_input", preparation: "none" };
      const vault = stores.vaults.get(target);
      if (!vault) return { status: "refused", reason: "unknown_target", preparation: "none" };
      const identity = `${parsed.data.gid}:${parsed.data.decision}`;
      const prior = unresolved.get(target);
      if (prior)
        return prior.identity === identity
          ? prior.result
          : { status: "not_started", reason: "pending_previous_attempt" };
      const current = () => sessionCurrent() && stores.vaults.get(target) === vault;
      const snapshot = proposalExecution(vault.store.read.bind(vault.store), parsed.data.gid);
      if (!snapshot) return { status: "refused", reason: "not_found", preparation: "none" };
      if (snapshot.status !== "pending")
        return { status: "refused", reason: "not_pending", preparation: "none" };
      if (parsed.data.decision === "reject") {
        const release = applyingLock.tryAcquire(target);
        if (!release) return { status: "refused", reason: "busy", preparation: "none" };
        try {
          const result = await runHostVaultCommand(
            vault,
            rejectProposal,
            { proposalGid: parsed.data.gid, note: null },
            mintUlid(Date.now()),
            current,
          );
          if (result.kind === "outcome_unknown") {
            const unknown = unknownUiCommand(result, rejectProposal.id);
            unresolved.set(target, { identity, result: unknown });
            return unknown;
          }
          if (result.kind === "not_started")
            return { status: "not_started", reason: "capability_unavailable" };
          if (result.kind === "refused")
            return { status: "refused", reason: result.reason, preparation: "none" };
          return {
            status: "completed",
            value: { status: "rejected", proposalGid: parsed.data.gid },
          };
        } finally {
          release();
        }
      }
      const approver =
        snapshot.kind === "strategy" || snapshot.kind === "custom_rule" ? strategies : provider;
      const binding = approver?.bind(target, stores);
      if (!binding?.isCurrent())
        return { status: "refused", reason: "capability_unavailable", preparation: "none" };
      const bound = () =>
        current() &&
        approver?.bind(target, stores)?.generation === binding.generation &&
        binding.isCurrent();
      if (!bound()) return { status: "refused", reason: "authority_lost", preparation: "none" };
      let prepared: Awaited<ReturnType<ProposalApprovalBinding["prepare"]>>;
      try {
        prepared = await binding.prepare(snapshot);
      } catch (error) {
        return { status: "refused", reason: preparationRefusal(error), preparation: "none" };
      }
      if (prepared.effect.proposalGid !== snapshot.gid || prepared.effect.kind !== snapshot.kind)
        return { status: "refused", reason: "wrong_preparation", preparation: "retained" };
      let preparationId = preparationIds.get(prepared.effect);
      if (preparationId === undefined) {
        preparationId = randomUUID();
        preparationIds.set(prepared.effect, preparationId);
      }
      if (!bound()) return { status: "refused", reason: "authority_lost", preparation: "retained" };
      const outcome = await executePreparedApproval(
        {
          store: vault.store,
          writer: vault.writer,
          env: vault.env,
          dailyLock: binding.dailyLock,
          applyingLock,
          runWrite: (work) => vault.queue.run(work),
          ...(vault.native === undefined
            ? {}
            : {
                runDurable: <I, R>(
                  command: Command<I, R>,
                  value: I,
                  serviceCurrent: () => boolean,
                ) => {
                  const decisionCurrent = () => bound() && serviceCurrent();
                  if (command.id !== "core.approvePrepared")
                    return runHostVaultCommand(
                      vault,
                      command,
                      value,
                      mintUlid(Date.now()),
                      decisionCurrent,
                    );
                  const checked = bindApprovalIntent(
                    command,
                    value,
                    parsed.data.gid,
                    preparationId,
                  );
                  return runHostVaultCommand(
                    vault,
                    checked.command,
                    checked.input,
                    mintUlid(Date.now()),
                    decisionCurrent,
                  );
                },
              }),
          isVaultCurrent: bound,
          isHolder: () => bound() && binding.isHolder(),
        },
        prepared.effect,
        prepared.publication,
      );
      if (outcome.status === "outcome_unknown") {
        const unknown = {
          status: "outcome_unknown",
          reason: "interrupted",
          attempt: { key: outcome.key, command: outcome.command },
        } as const;
        unresolved.set(target, { identity, result: unknown });
        return unknown;
      }
      return { status: "completed", value: outcome } satisfies UiActionResult<typeof outcome>;
    },
  };
}
