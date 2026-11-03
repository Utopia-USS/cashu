import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../command.js";
import {
  type ExecutionSnapshot,
  type PreparedEffect,
  proposalExecution,
} from "./proposal-execution.js";

const kind = z.enum(["strategy", "custom_rule", "import", "budget_import"]);
const gid = z.string().min(1);
const resultObject = z.record(z.string(), z.unknown());
const requiresImportHolder = (kind: ExecutionSnapshot["kind"]): boolean =>
  kind === "import" || kind === "budget_import";

const currentPending = (
  ctx: CommandContext,
  proposalGid: string,
): ExecutionSnapshot | undefined => {
  const proposal = proposalExecution(ctx.read, proposalGid);
  return proposal?.status === "pending" ? proposal : undefined;
};

export const createProposal = defineCommand({
  id: "core.createProposal",
  input: z.object({
    kind,
    summary: z.string(),
    reason: z.string().nullable(),
    payload: resultObject,
    source: z.string().min(1),
  }),
  run(ctx, input) {
    if ("account_id" in input.payload || "staged" in input.payload)
      return refuse("invalid_payload");
    const proposalGid = ctx.newGid();
    ctx.emit("proposal.created", proposalGid, input);
    return ok({ proposalGid });
  },
});

export const rejectProposal = defineCommand({
  id: "core.rejectProposal",
  input: z.object({ proposalGid: gid, note: z.string().nullable() }),
  run(ctx, input) {
    const current = currentPending(ctx, input.proposalGid);
    if (!current) return refuse("not_pending");
    if (requiresImportHolder(current.kind) && !ctx.lease.isHolder()) return refuse("not_holder");
    ctx.emit("proposal.rejected", input.proposalGid, { note: input.note });
    return ok({ proposalGid: input.proposalGid });
  },
});

export const failPendingProposal = defineCommand({
  id: "core.failPendingProposal",
  input: z.object({ proposalGid: gid, result: resultObject }),
  run(ctx, input) {
    const current = currentPending(ctx, input.proposalGid);
    if (!current) return refuse("not_pending");
    if (requiresImportHolder(current.kind) && !ctx.lease.isHolder()) return refuse("not_holder");
    ctx.emit("proposal.failed", input.proposalGid, { result: input.result });
    return ok({ proposalGid: input.proposalGid });
  },
});

/** Mark a post-approval publication failure only for this proposal's winning approval. */
export const failApprovedProposal = defineCommand({
  id: "core.failApprovedProposal",
  input: z.object({ proposalGid: gid, approvalEid: gid, result: resultObject }),
  run(ctx, input) {
    const current = proposalExecution(ctx.read, input.proposalGid);
    if (current?.status !== "approved" || current.approvalEid !== input.approvalEid)
      return refuse("not_winning_approval");
    if (requiresImportHolder(current.kind) && !ctx.lease.isHolder()) return refuse("not_holder");
    ctx.emit("proposal.applyFailed", input.proposalGid, {
      result: input.result,
      approval: input.approvalEid,
    });
    return ok({ proposalGid: input.proposalGid, approvalEid: input.approvalEid });
  },
});

/** Reuse an existing command under the approval's causal edge without a second append. */
function causedContext(ctx: CommandContext, approvalEid: string): CommandContext {
  const requireCause = (cause: string | undefined) => {
    if (cause !== undefined && cause !== approvalEid)
      throw new Error("prepared effect supplied a conflicting cause");
  };
  return {
    ...ctx,
    emit: (type, gid, data, opts) => {
      requireCause(opts?.cause);
      return ctx.emit(type, gid, data, { cause: approvalEid });
    },
    emitDeferred: (type, gid, resolveData, opts) => {
      requireCause(opts?.cause);
      return ctx.emitDeferred(type, gid, resolveData, { cause: approvalEid });
    },
  };
}

/** One validated append for the approval and every native side effect. */
export function approvePrepared<R>(effect: PreparedEffect<R>) {
  return defineCommand({
    id: "core.approvePrepared",
    input: z.object({}),
    run(ctx) {
      const current = currentPending(ctx, effect.proposalGid);
      if (!current) return refuse("not_pending");
      if (current.kind !== effect.kind) return refuse("wrong_kind");
      if (requiresImportHolder(current.kind) && !ctx.lease.isHolder()) return refuse("not_holder");
      const reason = effect.recheck(ctx, current);
      if (reason !== null) return refuse(reason);
      let effectValue: R;
      let applied = false;
      const approvalEid = ctx.emitDeferred("proposal.approved", current.gid, () => {
        if (!applied) throw new Error("approval result was not prepared");
        return { result: effect.approvalResult(effectValue, ctx, current) };
      });
      const outcome = effect.apply(causedContext(ctx, approvalEid), current, approvalEid);
      if (!outcome.ok) return outcome;
      effectValue = outcome.value;
      applied = true;
      return ok({ approvalEid, effect: effectValue });
    },
  });
}
