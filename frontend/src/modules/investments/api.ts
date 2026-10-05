// Investments module endpoints (profile-scoped, /api/p/{slug}/investments/...) plus the F3/F4
// contract endpoints the workspace uses: weekly reviews and agent proposals (track M). Shapes mirror
// service/views.py; money is a JSON number next to its currency, weights are fractions (0.213),
// drift is in percentage points.
import { ApiError, j, jpatch, jpost, pp } from "../../core/api";

export type Num = number | null;

export interface Alias { namespace: string; value: string; guessed: boolean }
export interface Instrument {
  id: number | string;
  symbol: string | null;
  name: string;
  label: string;
  isin: string | null;
  mic: string | null;
  currency: string;
  asset_class: string;
  region: string | null;
  sector: string | null;
  tags: string[];
  valuation_mode: string | null;
  status: string;
  needs_classification: boolean;
  aliases: Alias[];
}

export interface PortfolioWarning { kind: string; message: string; account_id: number | null; instrument_id: number | null }

export interface Run {
  id: number;
  trigger: string;
  as_of: string | null;
  status: string; // ok | partial | failed | running
  started_at: string | null;
  finished_at: string | null;
  errors: string[];
  stats: Record<string, unknown>;
  new_signal_ids: number[];
  escalated_signal_ids: number[];
}

export interface StrategyBrief {
  state: "missing" | "valid" | "partial" | "invalid" | string;
  version: number | null;
  changed: boolean;
  errors: number;
  warnings: number;
  inactive_rules: number;
}

export interface AccountRow {
  id: number;
  name: string;
  broker: string;
  broker_name: string;
  wrapper: string;
  currency: string;
  importer: string | null;
  has_mapping: boolean;
  active?: boolean;
  value?: Num;
  share?: Num;
  snapshot_date?: string | null;
  last_import?: { batch_id: number; at: string; file_name: string } | null;
}

export interface BucketRow {
  bucket_id: string;
  weight: Num;
  target: number;
  drift_pp: number;
  value: number;
  to_target: number;
  out_of_band: boolean | null;
  band_note: string | null;
  cash_history_gap: boolean;
  instrument_ids: (number | string)[];
}
export interface Share { key: string; value: number; weight: Num }
export interface Allocation {
  base_currency: string;
  total: number;
  has_strategy: boolean;
  buckets: BucketRow[];
  unclassified: { value: number; weight: Num; instruments: { id: number | string; label: string }[] } | null;
  unallocated_cash: Num;
  by_asset_class: Share[];
  by_region: Share[];
  band: { absolute_band_pp: number; relative_band: number; min_trade_value: number } | null;
}

export interface Overview {
  as_of: string;
  base_currency: string;
  accounts_filter: number[] | null;
  kpis: {
    value: { total: number; holdings: number; cash: number };
    unrealized: { amount: Num; pct: Num; cost: Num };
    cash: { amount: number; weight: Num; accounts: number };
    signals: { action: number; info: number; new: number };
    max_drift: { bucket_id: string; drift_pp: number; out_of_band: boolean | null } | null;
    out_of_band: number;
    last_run: Run | null;
    realized: Num;
  };
  allocation: Allocation;
  freshness: {
    prices: { newest_bar: string | null; stale: { instrument_id: number; label: string; price_date: string | null; account_id: number }[]; stale_count: number; stale_weight: Num };
    fx: { newest_rate: string | null; missing: string[] };
    strategy: StrategyBrief;
  };
  warnings: PortfolioWarning[];
  accounts: AccountRow[];
}

export interface Lot {
  account_id: number;
  open_date: string;
  quantity: number;
  unit_cost: Num;
  currency: string;
  open_txn_id: number | string | null;
  result: Num;
}
export interface PositionAccount {
  account_id: number;
  account_name: string | null;
  quantity: number;
  average_cost: Num;
  cost_currency: string;
  value: Num;
  cost: Num;
  unrealized_pct: Num;
  weight: Num;
}
export interface Position {
  instrument: Instrument;
  bucket: string | null;
  quantity: number;
  price: Num;
  price_date: string | null;
  price_currency: string | null;
  is_stale: boolean;
  valuation_mode: string;
  missing_fx_currency: string | null;
  value: Num;
  cost: Num;
  unrealized: Num;
  unrealized_pct: Num;
  weight: Num;
  realized: Num;
  dividends: Record<string, number>;
  accounts: PositionAccount[];
  lots: Lot[];
  open_signals: number;
  has_thesis: boolean;
}
export interface CashRow { account_id: number; account_name: string | null; currency: string; amount: number; amount_base: Num }
export interface Positions { as_of: string; base_currency: string; positions: Position[]; cash: CashRow[]; total: number }

export interface Txn {
  id: number | string;
  account_id: number;
  account_name: string | null;
  type: string;
  trade_date: string;
  instrument_id: number | string | null;
  quantity: Num;
  price: Num;
  currency: string;
  gross_amount: number;
  fee: number;
  tax: number;
  cash_amount: number;
  cash_currency: string;
  fx_rate: Num;
  split_ratio: string | null;
  source: string;
  note: string | null;
  external_ref: string | null;
}

export interface Decision {
  id: number;
  signal_id: number | null;
  instrument_id: number | null;
  account_id: number | null;
  action: string; // bought | sold | held | ignored | other
  quantity: Num;
  price: Num;
  currency: string | null;
  reason: string | null;
  created_at: string | null;
}
export interface Thesis {
  id: number;
  instrument_id: number;
  entry_type: string | null;
  thesis: string | null;
  invalidation: string | null;
  exit_plan: string | null;
  size_plan: string | null;
  reviewed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}
export interface PositionDetail {
  instrument: Instrument | null;
  position: Position | null;
  series: { date: string; close: number }[];
  high_52w: Num;
  transactions: Txn[];
  theses: Thesis[];
  decisions: Decision[];
  manual_valuations: { id: number; instrument_id: number; as_of: string; unit_value: number; currency: string; note: string | null }[];
}

export interface Threshold { rule_id: string; kind: string; threshold: number; basis: "high" | "cost" | string; window_days: number | null; y: number }
export interface ChartMarker { date: string; type: "buy" | "sell" | string; quantity: Num; price: Num; currency: string; account_id: number | null }
export interface PositionChart {
  instrument_id: number;
  label: string;
  currency: string;
  valuation_mode: string;
  as_of: string;
  series: { date: string; close: number }[];
  high_52w: Num;
  last: { date: string; close: number } | null;
  cost: { average: Num; currency: string } | null;
  thresholds: Threshold[];
  markers: ChartMarker[];
}

export interface Signal {
  id: number;
  rule_id: string;
  kind: string;
  dedup_key: string;
  severity: "info" | "action" | string;
  status: "active" | "acknowledged" | "resolved" | "expired" | string;
  message: string;
  instrument_id: number | null;
  instrument_label: string | null;
  account_id: number | null;
  payload: Record<string, unknown>;
  first_seen_at: string | null;
  last_seen_at: string | null;
  acknowledged_at: string | null;
  closed_at: string | null;
  decisions: Decision[];
}

/** `code` + `params`: stable code of the message for the Polish label (core/messages.ts); `message` stays English. */
export interface StrategyIssue { severity: string; path: string; message: string; line: number | null; column: number | null; code?: string; params?: Record<string, string> }
export interface BucketMatch { id: string; asset_class: string[]; tags: string[]; mic: string[]; currency: string[]; instrument_ids: (number | string)[] }
export interface StrategyStatus extends Omit<StrategyBrief, "inactive_rules"> {
  files: { yaml: string; md: string; yaml_exists: boolean; md_exists: boolean };
  read_error: string | null;
  issues: StrategyIssue[];
  inactive_rules: { index: number; rule_id: string | null; kind: string | null; line: number | null; issues: StrategyIssue[] }[];
  facts: {
    base_currency: string;
    buckets: string[];
    targets: Record<string, number>;
    rules: { id: string; kind: string; severity: string; cooldown_days: number | null }[];
    horizon_years: number | null;
    contributions: { monthly_amount: number; day_of_month: number | null } | null;
    notifications: { immediate: string[]; digest_weekday: string };
    bucket_matches?: BucketMatch[];
  } | null;
  base_currency_note: string | null;
  versions: { version: number; state: string; created_at: string | null; sha256: string; issues: number }[];
}

/** `kind` is the stable code (label `import.<kind>` in core/messages.ts); `code` when the server sends it. */
export interface ImportWarning { message: string; row: number | null; kind: string; blocking: boolean; code?: string }
export interface PreviewRow {
  row: number;
  date: string;
  type: string;
  instrument: { id: number | string; label: string; new: boolean } | null;
  quantity: Num;
  price: Num;
  currency: string;
  amount: number;
  cash_currency: string;
  status: "new" | "duplicate" | string;
}
export interface ReconRow {
  instrument_id: number | string;
  label: string;
  broker_quantity: number;
  computed_quantity: number;
  delta: number;
  kind: string;
  currency: string;
  correction: { type: string; quantity: Num; price: Num; date: string; note: string | null } | null;
}
export interface Reconciliation { account_id: number; as_of: string | null; diffs: ReconRow[]; mismatches: number; warnings: string[] }
export interface ImportPreview {
  file_id: string;
  file_name: string;
  size: number;
  account: { id: number; name: string; broker: string; broker_name: string };
  importer: { id: string | null; name: string | null; detected: string[]; requested: string };
  can_commit: boolean;
  warnings: ImportWarning[];
  errors: ImportWarning[];
  previous_imports: { batch_id: number; at: string; file_name: string }[];
  account_hint: string | null;
  counts: { rows: number; new: number; duplicates: number; positions: number; renames: number; status_changes: number; new_instruments: number; warnings: number; errors: number } | null;
  rows: PreviewRow[];
  new_instruments: Instrument[];
  renames: unknown[];
  status_changes: unknown[];
  reconciliation: Reconciliation | null;
}
export interface CommitResult {
  batch_id: number;
  inserted: number;
  duplicates: number;
  new_instrument_ids: (number | string)[];
  positions: number;
  renames: number;
  status_changes: number;
  corrections: number;
  archive_path: string;
}
export interface Batch {
  id: number;
  account_id: number;
  importer: string;
  broker: string | null;
  file_name: string;
  inserted: number;
  duplicates: number;
  new_instruments: number;
  corrections: number;
  warnings: number;
  created_at: string;
  account_name?: string | null;
}

export interface ReviewDigest {
  as_of: string;
  since: string;
  since_at: string;
  until_at: string;
  baseline: "review" | "default_7d" | string;
  last_review: { done_at: string; notes: string | null; stats: Record<string, unknown> } | null;
  digest_weekday: string;
  review_due: boolean;
  value: { currency: string; then: Num; now: number; change: Num; change_pct: Num };
  signals: { new: Signal[]; escalated: Signal[]; resolved: Signal[]; open: number; undecided: number };
  imports: Batch[];
  transactions: { count: number; by_type: Record<string, number>; manual: number };
  decisions: Decision[];
  dividends: Record<string, number>;
  price_moves: { instrument_id: number; label: string; from_date: string; from: number; to_date: string; to: number; change_pct: number }[];
  warnings: PortfolioWarning[];
  stale_count: number;
  strategy: { version: number | null; state: string; changed_since: boolean };
}

/** Weekly review record (track M: finanse.core.reviews). */
export interface Review { id?: number; module: string; done_at: string; notes: string | null; stats?: Record<string, unknown> }

/** Agent proposal (track M, core/proposals.py). List shape: id, kind (strategy | custom_rule |
 * import), status (pending | approved | rejected | failed), summary, reason, source, created_at,
 * reviewed_at, result. Detail adds payload plus per kind: strategy `diff {yaml, md}`, `base_changed`;
 * custom_rule `rule_yaml`, `backtest`, `diff {yaml}`; import `account`, `file_name`, `preview`
 * (counts), `converter {name, sha256, changed, source, approved_before}`. */
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
  converter?: { name: string; sha256: string; changed?: boolean; source?: string | null; approved_before?: boolean; error?: string } | null;
  detail_error?: string;
}
export interface Backtest {
  evaluated?: number; step_days?: number; from?: string; to?: string; points_fired?: number; episodes?: number;
  first_fired?: string | null; last_fired?: string | null; instruments?: string[]; points_skipped?: number; skip_reasons?: string[]; note?: string;
}

// ---- endpoints ---------------------------------------------------------------
const inv = (slug: string, path: string) => pp(slug, `/investments${path}`);
const qs = (accounts: number[] | null) => (accounts && accounts.length ? `?accounts=${accounts.join(",")}` : "");

export const getOverview = (slug: string, accounts: number[] | null) => j<Overview>(inv(slug, `/overview${qs(accounts)}`));
export const getPositions = (slug: string, accounts: number[] | null) => j<Positions>(inv(slug, `/positions${qs(accounts)}`));
export const getPositionDetail = (slug: string, id: number | string) => j<PositionDetail>(inv(slug, `/positions/${id}`));
export const getAccounts = (slug: string) => j<AccountRow[]>(inv(slug, "/accounts"));
export const getSignals = (slug: string, status: "open" | "history" | "all" = "open") => j<Signal[]>(inv(slug, `/signals?status=${status}`));
export const getDecisions = (slug: string) => j<Decision[]>(inv(slug, "/decisions"));
export const getUnclassified = (slug: string) => j<Instrument[]>(inv(slug, "/instruments?unclassified=true"));
export const getStrategy = (slug: string) => j<StrategyStatus>(inv(slug, "/strategy"));
export const getTransactions = (slug: string, instrumentId?: number | string) =>
  j<Txn[]>(inv(slug, `/transactions${instrumentId != null ? `?instrument_id=${instrumentId}` : ""}`));
export const getImports = (slug: string) => j<Batch[]>(inv(slug, "/imports"));

/** Price chart with rule thresholds. Falls back to the position detail's series (no thresholds)
 * when the backend does not serve the chart endpoint yet. */
export const getPositionChart = async (slug: string, id: number | string, months = 24): Promise<PositionChart> => {
  try {
    return await j<PositionChart>(inv(slug, `/positions/${id}/chart?months=${months}`));
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404 && /Not Found/i.test(e.message))) throw e;
    const d = await getPositionDetail(slug, id);
    return {
      instrument_id: Number(id), label: d.instrument?.label ?? String(id), currency: d.position?.price_currency ?? d.instrument?.currency ?? "PLN",
      valuation_mode: d.position?.valuation_mode ?? "market", as_of: d.series[d.series.length - 1]?.date ?? "", series: d.series, high_52w: d.high_52w,
      last: d.series[d.series.length - 1] ?? null, cost: null, thresholds: [], markers: [],
    };
  }
};

export const getReviewDigest = (slug: string) => j<ReviewDigest>(inv(slug, "/review-digest"));

export const postRun = (slug: string, offline = false) => jpost<{ profiles: { status: string; errors: string[]; new_signals?: unknown; escalated_signals?: unknown }[]; market_error?: string | null; market_errors?: string[] }>(inv(slug, "/run"), { offline });

export interface DecisionInput { action: string; quantity?: number | null; price?: number | null; currency?: string | null; account_id?: number | null; reason?: string | null }
export const postDecision = (slug: string, signalId: number, b: DecisionInput) =>
  jpost<{ decision: Decision; signal: Signal }>(inv(slug, `/signals/${signalId}/decision`), b);
export const postAcknowledge = (slug: string, signalId: number, reason?: string) =>
  jpost<{ decision: Decision; signal: Signal }>(inv(slug, `/signals/${signalId}/acknowledge`), { reason: reason ?? null });

export interface ClassifyInput {
  asset_class?: string | null; tags?: string[] | null; valuation_mode?: string | null; region?: string | null;
  aliases?: { namespace: string; value: string }[];
}
export const patchInstrument = (slug: string, id: number | string, b: ClassifyInput) => jpatch<Instrument>(inv(slug, `/instruments/${id}`), b);

export interface ThesisInput { entry_type?: string | null; thesis?: string | null; invalidation?: string | null; exit_plan?: string | null; size_plan?: string | null; reviewed?: boolean }
export const postThesis = (slug: string, instrumentId: number | string, b: ThesisInput) => jpost<Thesis>(inv(slug, `/instruments/${instrumentId}/theses`), b);
export const patchThesis = (slug: string, id: number, b: ThesisInput) => jpatch<Thesis>(inv(slug, `/theses/${id}`), b);

export const postStrategyInit = (slug: string, template = "passive_etf") => jpost<{ written: string[]; status: StrategyStatus }>(inv(slug, "/strategy/init"), { template });
export const postStrategyReload = (slug: string) => jpost<StrategyStatus>(inv(slug, "/strategy/reload"), {});

export const postAccount = (slug: string, b: { name: string; broker: string; wrapper: string; currency: string }) => jpost<AccountRow>(inv(slug, "/accounts"), b);

export interface ManualTxnInput {
  account_id: number;
  type: string;
  trade_date: string;
  instrument_id?: number | string | null;
  instrument?: { symbol?: string | null; isin?: string | null; name?: string | null; currency?: string | null; exchange?: string | null; asset_class?: string | null } | null;
  quantity?: number | null;
  price?: number | null;
  gross_amount?: number | null;
  fee?: number | null;
  tax?: number | null;
  cash_amount?: number | null;
  currency?: string | null;
  cash_currency?: string | null;
  fx_rate?: number | null;
  split_ratio?: number | null;
  note?: string | null;
}
export const postTransaction = (slug: string, b: ManualTxnInput) =>
  jpost<{ transaction: Txn; instrument: Instrument | null; new_instrument: boolean; warnings: string[] }>(inv(slug, "/transactions"), b);

/** Import preview: multipart upload (file + account + importer + optional mapping YAML). */
export async function postImportPreview(slug: string, b: { file: File; account_id: number; importer: string; mapping?: string | null }): Promise<ImportPreview> {
  const fd = new FormData();
  fd.append("file", b.file, b.file.name);
  fd.append("account_id", String(b.account_id));
  fd.append("importer", b.importer);
  if (b.mapping) fd.append("mapping", b.mapping);
  return upload<ImportPreview>(inv(slug, "/import/preview"), fd);
}
export const postImportCommit = (slug: string, b: { file_id: string; file_name: string; account_id: number; importer: string; mapping?: string | null; corrections: (number | string)[] }) =>
  jpost<CommitResult>(inv(slug, "/import/commit"), b);

// Multipart goes around the JSON helper (same token header and error handling).
async function upload<T>(u: string, body: FormData): Promise<T> {
  if (import.meta.env.VITE_MOCK === "1") {
    const { mockFetch } = await import("../../core/mock");
    return mockFetch("POST", u, body) as Promise<T>;
  }
  const token = document.querySelector<HTMLMetaElement>('meta[name="finanse-token"]')?.content ?? "";
  const r = await fetch(u, { method: "POST", body, headers: token ? { "X-Finanse-Token": token } : {} });
  if (!r.ok) {
    let detail = "";
    try { const d = (await r.json())?.detail; detail = typeof d === "string" ? d : Array.isArray(d) ? d.map((x) => x?.msg ?? "").join("; ") : ""; } catch { /* not JSON */ }
    throw new ApiError(r.status, detail || `${u} → ${r.status}`);
  }
  return r.json() as Promise<T>;
}

// ---- weekly reviews + proposals (track M contract) ------------------------------
export const getReviews = (slug: string) => j<Review[] | { items: Review[] }>(pp(slug, "/reviews?module=investments"))
  .then((r) => (Array.isArray(r) ? r : r.items ?? []));
export const postReview = (slug: string, notes: string | null, stats?: Record<string, unknown>) =>
  jpost<Review>(pp(slug, "/reviews"), { module: "investments", notes, stats });

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
