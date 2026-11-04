// A connector-backed budget import proposal carries only a checked blob and binding fingerprint.
// The host validates the exact document bytes and injects its approved-code/holder gate; this
// module emits the import and cursor in the same caused approval batch.
import type { budget } from "@cashu/domain";
import { z } from "zod";
import { type CommandContext, type CommandRefusal, ok, refuse } from "../command.js";
import type { ExecutionSnapshot, PreparedEffect } from "../core/proposal-execution.js";
import { accountByMemberGid } from "../core/queries.js";
import { blobRef, gid } from "../events/v1/primitives.js";
import type { Read } from "../query.js";
import { importStatement } from "./commands.js";

export interface BudgetConnectorBinding {
  readonly id: string;
  readonly profileId: string;
  readonly accountId: string;
  readonly connectorId: string;
  readonly module: "budget";
  readonly baseCursor: string | null;
  readonly paramsDigest: string;
  readonly approvedCodeDigest: string;
  readonly interpreter: string;
  readonly newCursor: string | null;
}
const connectorBindingSchema = z.strictObject({
  id: gid,
  profileId: z.string().regex(/^[a-f0-9]{32}$/),
  accountId: gid,
  connectorId: z.string().min(1),
  module: z.literal("budget"),
  baseCursor: z.string().nullable(),
  paramsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  approvedCodeDigest: z.string().regex(/^[0-9a-f]{64}$/),
  interpreter: z.string().min(1),
  newCursor: z.string().nullable(),
});

const payloadSchema = z.looseObject({
  account: gid,
  blob: blobRef,
  file_name: z.string().min(1),
  file_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.literal("connector"),
  connector_binding: connectorBindingSchema.optional(),
});

/** Validate native metadata/target ownership, then explicitly refuse the unresolved connector gate. */
export function prepareBudgetImport(read: Read, snapshot: ExecutionSnapshot): CommandRefusal {
  if (snapshot.kind !== "budget_import") return refuse("wrong_kind");
  if (snapshot.status !== "pending") return refuse("not_pending");
  const parsed = payloadSchema.safeParse(snapshot.payload);
  if (!parsed.success) return refuse("invalid_payload");
  if (parsed.data.file_sha256 !== parsed.data.blob.sha256) return refuse("staged_changed");
  if (accountByMemberGid(read, parsed.data.account) === undefined) return refuse("no_account");
  return refuse("connector_binding_unsupported");
}

/** Fully prepared bytes are copied by the host after a bounded encrypted-blob read. */
export function prepareBudgetConnectorImport(input: {
  readonly read: Read;
  readonly snapshot: ExecutionSnapshot;
  readonly vault: string;
  readonly statement: budget.ParsedStatement;
  readonly check: (ctx: CommandContext, binding: BudgetConnectorBinding) => boolean;
}): ReturnType<typeof ok<PreparedEffect<unknown>>> | CommandRefusal {
  const { snapshot } = input;
  if (snapshot.kind !== "budget_import") return refuse("wrong_kind");
  if (snapshot.status !== "pending") return refuse("not_pending");
  const parsed = payloadSchema.safeParse(snapshot.payload);
  if (!parsed.success) return refuse("invalid_payload");
  const payload = parsed.data;
  const binding = payload.connector_binding;
  if (!binding) return refuse("invalid_payload");
  if (payload.file_sha256 !== payload.blob.sha256) return refuse("staged_changed");
  if (
    binding.profileId !== input.vault ||
    binding.accountId !== payload.account ||
    accountByMemberGid(input.read, payload.account)?.gid !== payload.account
  )
    return refuse("connector_binding_changed");
  const fingerprint = JSON.stringify(snapshot.payload);
  const commandInput = importStatement.input.parse({
    account: payload.account,
    statement: input.statement,
    source: "connector",
    filename: payload.file_name,
    archive: payload.blob,
    newestDayRule: true,
  });
  return ok({
    proposalGid: snapshot.gid,
    kind: "budget_import" as const,
    recheck(ctx, fresh) {
      if (ctx.vault !== input.vault || !ctx.lease.isHolder()) return "not_leader";
      if (
        fresh.gid !== snapshot.gid ||
        fresh.kind !== "budget_import" ||
        fresh.status !== "pending" ||
        JSON.stringify(fresh.payload) !== fingerprint
      )
        return "proposal_changed";
      return input.check(ctx, binding) ? null : "connector_binding_changed";
    },
    apply(ctx) {
      if (!input.check(ctx, binding)) return refuse("connector_binding_changed");
      const result = importStatement.run(ctx, commandInput);
      if (result.ok)
        ctx.emit("connectorBinding.cursorAdvanced", binding.id, { cursor: binding.newCursor });
      return result;
    },
    approvalResult(result) {
      return typeof result === "object" && result !== null
        ? (result as Record<string, unknown>)
        : { imported: true };
    },
  });
}
