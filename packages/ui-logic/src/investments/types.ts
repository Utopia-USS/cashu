// Investments payload shapes the shared UI logic reads (they mirror service/views.py; transport in the app's api.ts).
// Money is a JSON number next to its currency, weights are fractions. Types only.

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
  /** Every signal the decision answers (position decisions link several; F9 BE). Older servers: absent. */
  signal_ids?: number[];
}

/** P3 one reason a recommendation may be outdated: `at` = when it happened (UTC ISO); note reasons carry the newest
 * note, its relation and how many notes qualify; rule / alert reasons the signal / alert id and the kind. */
export interface FreshReason {
  code: string;
  at: string | null;
  note_id?: number | null;
  relation?: string | null;
  count?: number | null;
  signal_id?: number | null;
  alert_id?: number | null;
  kind?: string | null;
}

/** P2 strategy hint: which of the owner's own rules apply now (BE decides code, severity and order, main first).
 * Params are fractions as in the rules (0.27 = 27 %). */
export interface Hint {
  code: string;
  severity: "rule" | "review" | "info" | string;
  params: Record<string, unknown>;
}

export type Num = number | null;

export interface PlanFreshness {
  state: "fresh" | "maybe_outdated" | "outdated" | string;
  reasons: FreshReason[];
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
  /** "Odłóż do" (track AL, F5 R7): hidden from the to-do list while `snoozed`. */
  snoozed_until?: string | null;
  snoozed?: boolean;
  decisions: Decision[];
}

export interface StrategyDoc {
  id: string;
  main: boolean;
  executed: boolean;
  title: string | null;
  status: string | null;
  description: string | null;
  main_file: string | null;
  /** Absolute folder the file paths are relative to. */
  root: string;
  files: StrategyDocFile[];
  /** `_main` only: the validation brief of the executed strategy. */
  brief?: {
    state: string;
    version: number | null;
    changed: boolean;
    errors: number;
    warnings: number;
    inactive_rules: number;
  };
}

/** One strategy of the Strategie tab (docs/agents/strategies.md): `_main` is the executed strategy.md / .yaml. */
export interface StrategyDocFile {
  path: string;
  kind: "md" | "yaml" | "text";
}

// ---- ab24ab6 frontend/src/modules/investments/api.ts: the payloads of the Home and the review deck ----------
export interface Alias {
  namespace: string;
  value: string;
  guessed: boolean;
}

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
  /** Model recommendation (legacy field name): buy_asap | buy | hold | reduce | exit_asap. */
  plan?: string | null;
  /** When the plan was set (UTC ISO), null without a plan. */
  plan_at?: string | null;
  /** The model's short reason for the recommendation, null without one. */
  plan_reason?: string | null;
  /** P3: whether data stored after `plan_at` puts the recommendation in question; null without a plan. Only on
   * positions rows, watchlist rows and the asset detail. */
  plan_freshness?: PlanFreshness | null;
  /** Position strength, the model's assessment of how well the thesis holds (never a trade call):
   * strong | neutral | weak, null = none. Always given by the agent; the recommendation (`plan`) is optional. */
  strength?: string | null;
  /** Why: on_track | fulfilled | undermined | environment_against | no_progress, null without a strength. */
  strength_basis?: string | null;
  /** The model's short reason for the strength, null without one. */
  strength_reason?: string | null;
  /** When the strength was set (UTC ISO), null without one. */
  strength_at?: string | null;
  /** P5 market segment: the effective key (set by the owner / agent, else the auto table) or null, and where it
   * comes from: `owner` | `agent` | `auto` | null (`set` from earlier servers = owner or agent). */
  segment?: string | null;
  segment_source?: "owner" | "agent" | "auto" | "set" | null;
}

export interface PortfolioWarning {
  kind: string;
  message: string;
  account_id: number | null;
  instrument_id: number | null;
}

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
  /** F7-generic: a template / plain asset-class bucket (missing on older servers = generic). */
  generic?: boolean;
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

export interface Share {
  key: string;
  value: number;
  weight: Num;
}

export interface Allocation {
  base_currency: string;
  total: number;
  has_strategy: boolean;
  buckets: BucketRow[];
  unclassified: {
    value: number;
    weight: Num;
    instruments: { id: number | string; label: string }[];
  } | null;
  unallocated_cash: Num;
  by_asset_class: Share[];
  by_region: Share[];
  band: { absolute_band_pp: number; relative_band: number; min_trade_value: number } | null;
  /** F7-generic: at least one bucket and every bucket generic (missing on older servers = generic). */
  buckets_generic?: boolean;
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
    prices: {
      newest_bar: string | null;
      stale: {
        instrument_id: number;
        label: string;
        price_date: string | null;
        account_id: number;
      }[];
      stale_count: number;
      stale_weight: Num;
    };
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
  /** P2: the owner's rules that apply now, main first (absent on older servers). */
  hints?: Hint[];
}

export interface CashRow {
  account_id: number;
  account_name: string | null;
  currency: string;
  amount: number;
  amount_base: Num;
}

export interface Positions {
  as_of: string;
  base_currency: string;
  positions: Position[];
  cash: CashRow[];
  total: number;
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
  /** The last change of `exit_plan` (null without a plan); older servers omit it. */
  exit_plan_changed_at?: string | null;
}

/** `code` + `params`: stable code of the message for the Polish label (core/messages.ts); `message` stays English. */
export interface StrategyIssue {
  severity: string;
  path: string;
  message: string;
  line: number | null;
  column: number | null;
  code?: string;
  params?: Record<string, string>;
}

export interface BucketMatch {
  id: string;
  asset_class: string[];
  tags: string[];
  mic: string[];
  currency: string[];
  instrument_ids: (number | string)[];
}

export interface StrategyStatus extends Omit<StrategyBrief, "inactive_rules"> {
  files: { yaml: string; md: string; yaml_exists: boolean; md_exists: boolean };
  read_error: string | null;
  issues: StrategyIssue[];
  inactive_rules: {
    index: number;
    rule_id: string | null;
    kind: string | null;
    line: number | null;
    issues: StrategyIssue[];
  }[];
  facts: {
    base_currency: string;
    buckets: string[];
    targets: Record<string, number>;
    rules: { id: string; kind: string; severity: string; cooldown_days: number | null }[];
    horizon_years: number | null;
    contributions: { monthly_amount: number; day_of_month: number | null } | null;
    notifications: { immediate: string[]; digest_weekday: string };
    /** "Close to the level" thresholds of the alert icons (strategy `alerts.near_price_pct` / `near_pp`, home v3 Q11). */
    alerts?: { near_price_pct?: number | null; near_pp?: number | null } | null;
    bucket_matches?: BucketMatch[];
  } | null;
  base_currency_note: string | null;
  versions: {
    version: number;
    state: string;
    created_at: string | null;
    sha256: string;
    issues: number;
  }[];
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
  signals: {
    new: Signal[];
    escalated: Signal[];
    resolved: Signal[];
    open: number;
    undecided: number;
  };
  imports: Batch[];
  transactions: { count: number; by_type: Record<string, number>; manual: number };
  decisions: Decision[];
  dividends: Record<string, number>;
  price_moves: {
    instrument_id: number;
    label: string;
    from_date: string;
    from: number;
    to_date: string;
    to: number;
    change_pct: number;
  }[];
  warnings: PortfolioWarning[];
  stale_count: number;
  strategy: { version: number | null; state: string; changed_since: boolean };
}

/** Weekly review record (track M: cashu.core.reviews). */
export interface Review {
  id?: number;
  module: string;
  done_at: string;
  notes: string | null;
  stats?: Record<string, unknown>;
}
