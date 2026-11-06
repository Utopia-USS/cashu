import { gid as proposalGid } from "../../events/v1/primitives.js";
import { defineQuery } from "../../query.js";
import type { UiAction } from "../../ui-actions.js";
import { SUMMARY_PARAMS } from "../proposal-commands.js";
import type { ProposalKind, ProposalStatus } from "../proposal-execution.js";
import type { ApprovalExecutionResult } from "../proposal-service.js";

const kinds: readonly ProposalKind[] = ["strategy", "custom_rule", "import", "budget_import"];
const statuses: readonly ProposalStatus[] = ["pending", "approved", "rejected", "failed"];

export interface ProposalListRow {
  readonly gid: string;
  readonly kind: ProposalKind;
  readonly status: ProposalStatus;
  /** One English line (the app shows it when no localized line is built from the code). */
  readonly summary: string;
  /** Python `summary_code`: the kind, the catalog key (`proposal.<code>`) of the localized line. */
  readonly summaryCode: ProposalKind;
  /** Python `summary_params`: the localized line's values (empty in privacy mode). */
  readonly summaryParams: Readonly<Record<string, unknown>>;
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

interface StoredProposal extends Omit<ProposalListRow, "summaryCode" | "summaryParams"> {
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
const params = (value: unknown): Readonly<Record<string, unknown>> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** Python `proposal_dict`: the summary code (= the kind) and the values stored in the payload. */
function proposalSummaryOf(
  kind: ProposalKind,
  payload: Readonly<Record<string, unknown>>,
  privacy: boolean,
): Pick<ProposalListRow, "summaryCode" | "summaryParams"> {
  return { summaryCode: kind, summaryParams: privacy ? {} : params(payload[SUMMARY_PARAMS]) };
}

/** Newest-first, bounded list. Payload is deliberately absent. */
export const proposalList = defineQuery({
  id: "core.desktopProposals.list",
  run(read, args: { readonly status?: ProposalStatus | null; readonly privacy: boolean }) {
    const status = args.status;
    if (status !== undefined && status !== null && !validStatus(status)) return [];
    const rows = read<StoredProposal & { kind: string; status: string }>(
      `SELECT gid, kind, status, summary, reason, source,
              created_at AS createdAt, reviewed_at AS reviewedAt, payload, result
         FROM proposals WHERE (? IS NULL OR status = ?)
         ORDER BY created_at DESC, gid ASC LIMIT 100`,
      status ?? null,
      status ?? null,
    );
    return rows
      .filter((row): row is StoredProposal => validKind(row.kind) && validStatus(row.status))
      .map(({ payload, result: _result, ...row }): ProposalListRow => {
        const summary = proposalSummaryOf(row.kind, object(payload), args.privacy);
        return args.privacy
          ? { ...row, ...summary, summary: "", reason: null, source: "" }
          : { ...row, ...summary };
      });
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
    const payload = object(row.payload);
    return {
      gid: row.gid,
      kind: row.kind,
      status: row.status,
      summary: args.privacy ? "" : row.summary,
      ...proposalSummaryOf(row.kind, payload, args.privacy),
      reason: args.privacy ? null : row.reason,
      source: args.privacy ? "" : row.source,
      createdAt: row.createdAt,
      reviewedAt: row.reviewedAt,
      payload: args.privacy ? {} : payload,
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
