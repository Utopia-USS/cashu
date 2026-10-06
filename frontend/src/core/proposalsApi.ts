// Agent proposals (track M, core/proposals.py; routes `/api/p/{slug}/proposals`): investments strategy / rule /
// import proposals and the budget connector sync proposals (`budget_import`). Moved here from the investments
// module (design/v3/connectors section 6); investments re-exports them.
import { ApiError, j, jpost, pp } from "./api";

/** Agent proposal (track M, core/proposals.py). List shape: id, kind (strategy | custom_rule |
 * import | budget_import), status (pending | approved | rejected | failed), summary, reason, source, created_at,
 * reviewed_at, result. Detail adds payload plus per kind: strategy `diff {yaml, md}`, `base_changed`;
 * custom_rule `rule_yaml`, `backtest`, `diff {yaml}`; import `account`, `file_name`, `preview`
 * (counts); `converter_unsupported` for an import stored with a converter script from before connectors
 * (the app runs code only as a connector the owner approved in Ustawienia > Konektory; such a proposal cannot
 * be approved). */
export interface Proposal {
  id: number;
  kind: string;
  status: string;
  summary?: string | null;
  /** The kind, and the summary's values, for the Polish line (core/messages.ts proposalSummary). */
  summary_code?: string | null;
  summary_params?: Record<string, unknown> | null;
  reason?: string | null;
  source?: string | null;
  created_at: string | null;
  reviewed_at?: string | null;
  result?: Record<string, unknown> | null;
  payload?: Record<string, unknown>;
  diff?: string | { yaml?: string | null; md?: string | null } | null;
  base_changed?: boolean;
  rule_yaml?: string | null;
  backtest?: Backtest | null;
  account?: string | null;
  file_name?: string | null;
  preview?: Record<string, number | boolean | string> | null;
  converter_unsupported?: boolean;
  /** budget_import (contract C8): the account's label, the connector, the sync's `since`. */
  account_label?: string | null;
  connector_name?: string | null;
  since?: string | null;
  detail_error?: string;
}
export interface Backtest {
  evaluated?: number; step_days?: number; from?: string; to?: string; points_fired?: number; episodes?: number;
  first_fired?: string | null; last_fired?: string | null; instruments?: string[]; points_skipped?: number; skip_reasons?: string[]; note?: string;
}

/** Pending (or other) proposals; an absent endpoint (track M not landed) reads as "none". */
export const getProposals = async (slug: string, status = "pending"): Promise<Proposal[]> => {
  try {
    const r = await j<Proposal[] | { items: Proposal[] }>(pp(slug, `/proposals?status=${status}`));
    return Array.isArray(r) ? r : r.items ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
};
export const getProposal = (slug: string, id: number) => j<Proposal>(pp(slug, `/proposals/${id}`));
export const approveProposal = (slug: string, id: number) => jpost<Proposal>(pp(slug, `/proposals/${id}/approve`), {});
export const rejectProposal = (slug: string, id: number) => jpost<Proposal>(pp(slug, `/proposals/${id}/reject`), {});
