import type { CommandContext, CommandResult } from "../command.js";
import type { Read } from "../query.js";

export type ProposalKind = "strategy" | "custom_rule" | "import" | "budget_import" | "account_removal";
export type ProposalStatus = "pending" | "approved" | "rejected" | "failed";

/** Pending investment proposals, without payloads or execution capabilities. */
export function pendingProposals(read: Read) {
  return read<{
    gid: string;
    kind: "strategy" | "custom_rule" | "import";
    summary: string;
    reason: string | null;
    createdAt: string;
  }>(
    "SELECT gid, kind, summary, reason, created_at AS createdAt FROM proposals WHERE status = 'pending' AND kind IN ('strategy', 'custom_rule', 'import') ORDER BY created_at DESC, gid ASC",
  );
}

/** Current folded row and the approval eid that actually decided it. */
export interface ExecutionSnapshot {
  readonly gid: string;
  readonly kind: ProposalKind;
  readonly status: ProposalStatus;
  readonly summary: string;
  readonly reason: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly approvalEid: string | null;
}

/** Pure, fully prepared effect. File I/O and network work happen before/after this short command. */
export interface PreparedEffect<R> {
  readonly proposalGid: string;
  readonly kind: ProposalKind;
  /** Kind-specific current-state guard, including any base digest check it actually requires. */
  recheck(ctx: CommandContext, snapshot: ExecutionSnapshot): string | null;
  /** Emit side effects through a context that forces their cause to the approval eid. */
  apply(ctx: CommandContext, snapshot: ExecutionSnapshot, approvalEid: string): CommandResult<R>;
  /** True result derived from the effect's actual output, resolved before the single append. */
  approvalResult(
    result: R,
    ctx: CommandContext,
    snapshot: ExecutionSnapshot,
  ): Record<string, unknown>;
}

interface ProposalRow {
  gid: string;
  kind: string;
  status: string;
  summary: string;
  reason: string | null;
  payload: string;
  result: string;
  source: string;
  approval_eid: string | null;
}

function jsonObject(text: string): Readonly<Record<string, unknown>> {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("stored proposal JSON is not an object");
  return value as Record<string, unknown>;
}

/** Read one vault's proposal only; the supplied Read is already scoped to that vault. */
export function proposalExecution(read: Read, gid: string): ExecutionSnapshot | undefined {
  const row = read<ProposalRow>(
    `SELECT p.gid, p.kind, p.status, p.summary, p.reason, p.payload, p.result, p.source,
            a.eid AS approval_eid
       FROM proposals p LEFT JOIN fold_proposal_approval a ON a.gid = p.gid
      WHERE p.gid = ?`,
    gid,
  )[0];
  if (row === undefined) return undefined;
  if (
    !["strategy", "custom_rule", "import", "budget_import", "account_removal"].includes(row.kind) ||
    !["pending", "approved", "rejected", "failed"].includes(row.status)
  )
    throw new Error("stored proposal has an unsupported kind or status");
  return {
    gid: row.gid,
    kind: row.kind as ProposalKind,
    status: row.status as ProposalStatus,
    summary: row.summary,
    reason: row.reason,
    payload: jsonObject(row.payload),
    result: jsonObject(row.result),
    source: row.source,
    approvalEid: row.approval_eid,
  };
}

/** Whether this exact approval eid still wins and has not been revoked by applyFailed. */
export function isEffectiveProposalApproval(read: Read, approvalEid: string): boolean {
  return (
    read<{ present: number }>(
      `SELECT 1 AS present
         FROM fold_proposal_approval a JOIN proposals p ON p.gid = a.gid
        WHERE a.eid = ? AND p.status = 'approved'
        LIMIT 1`,
      approvalEid,
    ).length !== 0
  );
}
