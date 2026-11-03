import { gid as proposalGid } from "../../events/v1/primitives.js";
import { defineQuery } from "../../query.js";
import type { UiAction } from "../../ui-actions.js";
import type { ProposalKind, ProposalStatus } from "../proposal-execution.js";
import type { ApprovalExecutionResult } from "../proposal-service.js";

const kinds: readonly ProposalKind[] = ["strategy", "custom_rule", "import", "budget_import"];
const statuses: readonly ProposalStatus[] = ["pending", "approved", "rejected", "failed"];

export interface ProposalListRow {
  readonly gid: string;
  readonly kind: ProposalKind;
  readonly status: ProposalStatus;
  readonly summary: string;
  readonly reason: string | null;
  readonly source: string;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
}

export interface ProposalDetail extends ProposalListRow {
  readonly payload: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>>;
  readonly nextStrategyVersion: number | null;
  readonly display?: ProposalDisplay;
}

/** Host-derived display facts from a checked current-file image and the stored proposal. */
export interface ProposalDisplay {
  readonly diffAvailability: "ready" | "unavailable";
  readonly yamlDiff: string | null;
  readonly mdDiff: string | null;
  readonly baseChanged: boolean | null;
  readonly ruleYaml: string | null;
  readonly backtest: Readonly<Record<string, unknown>> | null;
  readonly preview: Readonly<Record<string, unknown>> | null;
  readonly account: string | null;
  readonly accountLabel: string | null;
  readonly connectorName: string | null;
  readonly fileName: string | null;
  readonly since: string | null;
  readonly fromConnector: boolean;
  readonly converterUnsupported: boolean;
  readonly detailError: string | null;
}

interface StoredProposal extends ProposalListRow {
  readonly payload: string;
  readonly result: string;
}

const validKind = (value: string): value is ProposalKind => kinds.some((kind) => kind === value);
const validStatus = (value: string): value is ProposalStatus =>
  statuses.some((status) => status === value);
const object = (raw: string): Readonly<Record<string, unknown>> => {
  const value: unknown = JSON.parse(raw);
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

/** Newest-first, bounded list. Payload is deliberately absent. */
export const proposalList = defineQuery({
  id: "core.desktopProposals.list",
  run(read, args: { readonly status?: ProposalStatus | null; readonly privacy: boolean }) {
    const status = args.status;
    if (status !== undefined && status !== null && !validStatus(status)) return [];
    const rows = read<ProposalListRow & { kind: string; status: string }>(
      `SELECT gid, kind, status, summary, reason, source,
              created_at AS createdAt, reviewed_at AS reviewedAt
         FROM proposals WHERE (? IS NULL OR status = ?)
         ORDER BY created_at DESC, gid ASC LIMIT 100`,
      status ?? null,
      status ?? null,
    );
    return rows
      .filter((row): row is ProposalListRow => validKind(row.kind) && validStatus(row.status))
      .map((row) => (args.privacy ? { ...row, summary: "", reason: null, source: "" } : row));
  },
});

/** Canonical selected proposal, with a distinct not-found result. */
export const proposalDetail = defineQuery({
  id: "core.desktopProposals.detail",
  run(read, args: { readonly gid: string; readonly privacy: boolean }): ProposalDetail | null {
    if (!proposalGid.safeParse(args.gid).success) return null;
    const row = read<StoredProposal>(
      `SELECT gid, kind, status, summary, reason, source,
              created_at AS createdAt, reviewed_at AS reviewedAt, payload, result
         FROM proposals WHERE gid = ?`,
      args.gid,
    )[0];
    if (!row || !validKind(row.kind) || !validStatus(row.status)) return null;
    return {
      gid: row.gid,
      kind: row.kind,
      status: row.status,
      summary: args.privacy ? "" : row.summary,
      reason: args.privacy ? null : row.reason,
      source: args.privacy ? "" : row.source,
      createdAt: row.createdAt,
      reviewedAt: row.reviewedAt,
      payload: args.privacy ? {} : object(row.payload),
      result: args.privacy ? {} : object(row.result),
      nextStrategyVersion:
        row.kind === "strategy" || row.kind === "custom_rule"
          ? (read<{ version: number }>(
              "SELECT MAX(version) AS version FROM inv_strategy_versions",
            )[0]?.version ?? 0) + 1
          : null,
    };
  },
});

export type ProposalReviewOutcome =
  | { readonly status: "rejected"; readonly proposalGid: string }
  | ApprovalExecutionResult<unknown>;

/** Host-owned execution. The renderer supplies an intent, never an effect or file path. */
export const proposalReview: UiAction<
  { readonly gid: string; readonly decision: "approve" | "reject" },
  ProposalReviewOutcome
> = { id: "core.desktopProposals.review" };
