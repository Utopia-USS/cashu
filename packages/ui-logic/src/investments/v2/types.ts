// v2 investments payload shapes the shared UI logic reads (signals, alerts, calendar, instrument search; they
// mirror service/views.py). Types only.
import type {
  Decision,
  Hint,
  Instrument,
  Num,
  Overview,
  Position,
  Positions,
  ReviewDigest,
  Signal,
  Thesis,
} from "../types.js";

export interface Alert {
  id: number;
  kind: string;
  scope: "instrument" | "portfolio" | "bucket" | string;
  instrument_id: number | null;
  instrument: {
    id: number | string;
    label: string;
    symbol: string | null;
    name: string;
    isin: string | null;
    currency: string;
    asset_class: string;
    valuation_mode: string | null;
  } | null;
  params: Record<string, unknown>;
  unit: "price" | "ratio" | "none" | string | null;
  polarity: Polarity | string;
  severity: "info" | "action" | string;
  title: string;
  note: string | null;
  /** Free label by the owner or the agent (`cena`, `wydarzenie`, ...); null: the UI takes one from the kind. Older
   * servers omit it. */
  tag?: string | null;
  source: "user" | "agent" | string;
  created_by: string | null;
  status: "active" | "triggered" | "snoozed" | "muted" | "expired" | string;
  cooldown_days: number | null;
  expires_at: string | null;
  snoozed_until: string | null;
  last_triggered_at: string | null;
  last_checked_at: string | null;
  last_value: Num;
  signal: { id: number; status: string; message: string; first_seen_at: string | null } | null;
  /** F8 BE (dynamic kinds): the last run's range (range_breakout) or the average volume (volume_spike). */
  state?: {
    range_low?: number | string | null;
    range_high?: number | string | null;
    range_pct?: number | null;
    close?: number | null;
    currency?: string | null;
    average_volume?: number | string | null;
    volume?: number | null;
    ratio?: number | null;
    window_days?: number | null;
  } | null;
  created_at: string | null;
  updated_at: string | null;
}

/** One dated event of the review's calendar card (`GET /investments/calendar`): a high-impact macro release
 * (public feed), earnings of a held / watched US instrument (public list, matched on the server) or a research
 * note's `details.event_date`. `time`: "HH:MM" local, "przed sesją" / "po sesji", or null. */
export interface CalendarEvent {
  date: string;
  time: string | null;
  kind: "macro" | "earnings" | "research" | string;
  title: string;
  country: string | null;
  country_label: string | null;
  instrument_id: number | null;
  label: string | null;
  held: boolean | null;
  note_id: number | null;
}

/** The profile's entry state of a hit: held (in holdings), watched (active watch row), saved (referenced, e.g. a
 * removed watch row or research notes), new (not in the profile). */
export type EntryState = "held" | "watched" | "saved" | "new";

export type Polarity = "positive" | "negative" | "neutral";

// ---- instrument search (F12 B4) -------------------------------------------------------------------
export interface SearchHit {
  /** Stable per hit: `i:<id>` (instrument), `y:<symbol>` (remote). */
  key: string;
  instrument_id: number | null;
  state: EntryState | string;
  symbol: string;
  yahoo_symbol: string | null;
  name: string;
  exchange: string | null;
  mic: string | null;
  asset_class: string;
  /** Remote hits: the market's currency hint, may be wrong (never shown). */
  currency: string | null;
  isin: string | null;
  source: "local" | "yahoo" | "openfigi" | string;
}

/** A search hit picked to watch (F12 B3): the backend verifies the Yahoo symbol and reads the currency from it. */
export interface SearchPick {
  yahoo_symbol: string;
  ticker?: string | null;
  name?: string | null;
  asset_class?: string | null;
  mic?: string | null;
  isin?: string | null;
}

export interface SearchResult {
  query: string;
  local: SearchHit[];
  remote: SearchHit[];
  remote_status: "ok" | "unavailable" | "skipped" | string;
}

export interface SignalV2 extends Signal {
  polarity?: Polarity | string;
  source?: "rule" | "alert" | string;
  alert_id?: number | null;
  snoozed_until?: string | null;
  snoozed?: boolean;
  /** Alert signals (F6 BE): `alert.<kind>` + params for the Polish fact (core/messages.ts); null for rules. */
  message_code?: string | null;
  message_params?: Record<string, unknown> | null;
  /** F8 BE: the profile's last non-failed rules run confirmed it (research signals: true); absent on older servers. */
  current?: boolean | null;
  /** F8 BE: the instrument is held in any account of the profile (null for portfolio-wide signals). */
  held?: boolean | null;
}

/** Exactly one of `pick`, `instrument_id`, `symbol_or_isin`. */
export interface WatchInput {
  symbol_or_isin?: string;
  instrument_id?: number;
  pick?: SearchPick;
  note?: string | null;
  currency?: string | null;
  tags?: string[] | null;
}

// ---- ab24ab6 frontend/src/modules/investments/v2/api.ts: overview, positions, watchlist, digest, performance --
export interface AttentionItem {
  type: "signal" | "alert";
  signal_id: number;
  alert_id: number | null;
  kind: string;
  rule_id: string;
  polarity: Polarity | string;
  severity: string;
  status: string;
  title: string;
  message: string;
  source: string;
  instrument_id: number | null;
  instrument_label: string | null;
  held: boolean;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface AlertCounts {
  active: number;
  triggered: number;
  snoozed: number;
  muted: number;
  expired: number;
  agent_live: number;
}

export interface OverviewV2 extends Overview {
  kpis: Overview["kpis"] & { polarity?: Record<Polarity, number>; alerts?: AlertCounts };
  attention?: AttentionItem[];
  attention_total?: number;
}

export interface Close {
  date: string;
  close: number;
}

/** `research_unread` (F8 BE): the instrument's unread agent research notes. */
export type PositionV2 = Position & { closes_30d?: Close[]; research_unread?: number };

export type PositionsV2 = Omit<Positions, "positions"> & { positions: PositionV2[] };

export interface WatchItem {
  id: number;
  instrument_id: number;
  instrument: Instrument | null;
  note: string | null;
  tags: string[];
  source: "user" | "agent" | string;
  added_at: string | null;
  held: boolean;
  price_source: boolean;
  price: {
    close: number;
    date: string;
    currency: string;
    stale: boolean;
    change_1d: Num;
    change_1m: Num;
    high_52w: Num;
    high_52w_date: string | null;
    from_high_52w: Num;
    bars: number;
  } | null;
  closes_30d?: Close[];
  alerts: {
    count?: number;
    live: number;
    triggered: number;
    nearest?: {
      alert_id: number;
      kind: string;
      title: string;
      level: Num;
      distance_pct: Num;
    } | null;
  };
  /** F8 BE: unread agent research notes of the instrument. */
  research_unread?: number;
  /** P2: the owner's rules that apply now (held: the held table), main first. */
  hints?: Hint[];
}

/** One transaction of the position detail (api.ts `Txn`). */
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

/** `GET /positions/{id}` (api.ts `PositionDetail`): the asset detail's instrument, position and history. */
export interface PositionDetail {
  instrument: Instrument | null;
  position: Position | null;
  series: Close[];
  high_52w: Num;
  transactions: Txn[];
  theses: Thesis[];
  decisions: Decision[];
  manual_valuations: {
    id: number;
    instrument_id: number;
    as_of: string;
    unit_value: number;
    currency: string;
    note: string | null;
  }[];
  /** P2: held = the position row's hints, watched = the watched table, else []. */
  hints?: Hint[];
}

/** A rule threshold drawn on the price chart. */
export interface Threshold {
  rule_id: string;
  kind: string;
  threshold: number;
  basis: "high" | "cost" | string;
  window_days: number | null;
  y: number;
}
export interface ChartMarker {
  date: string;
  type: "buy" | "sell" | string;
  quantity: Num;
  price: Num;
  currency: string;
  account_id: number | null;
}
/** `GET /positions/{id}/chart?months=` (api.ts `PositionChart`). */
export interface PositionChart {
  instrument_id: number;
  label: string;
  currency: string;
  valuation_mode: string;
  as_of: string;
  series: Close[];
  high_52w: Num;
  last: Close | null;
  cost: { average: Num; currency: string } | null;
  thresholds: Threshold[];
  markers: ChartMarker[];
}

export interface DigestEvent {
  type:
    | "signal_created"
    | "alert_triggered"
    | "signal_escalated"
    | "signal_resolved"
    | "import"
    | "decision"
    | "deposit"
    | "withdrawal"
    | "data_warning"
    | string;
  at: string;
  date: string;
  signal_id?: number;
  alert_id?: number | null;
  kind?: string;
  polarity?: string;
  status?: string;
  message?: string;
  instrument_id?: number | null;
  instrument_label?: string | null;
  rule_id?: string;
  severity?: string;
  /** Allocation-drift signal events: the bucket (F6 BE). */
  bucket_id?: string | null;
  /** Alert signal events: `alert.<kind>` + params (F6 BE), the Polish fact via core/messages.ts. */
  message_code?: string | null;
  message_params?: Record<string, unknown> | null;
  file_name?: string;
  inserted?: number;
  account_id?: number | null;
  action?: string;
  reason?: string | null;
  amount?: Num;
  currency?: string;
  count?: number;
}

export interface DigestV2 extends ReviewDigest {
  /** The owner's review (strategy.yaml `review:`): name, every (week | 2weeks | month), weekday, the deck's cards
   * in order and the next scheduled day after a review done today; missing on older servers. */
  review?: { name: string; every: string; day: string; cards: string[]; next_on: string | null };
  events?: DigestEvent[];
  events_total?: number;
  /** F7 (V4): `market_change` excludes `transfers` (units moved in / out, adjustments, cash transfers) and
   * `implied_funding`; both reported separately (base currency, null when they cannot be valued). */
  value: ReviewDigest["value"] & {
    contributions?: Num;
    market_change?: Num;
    market_change_pct?: Num;
    transfers?: Num;
    implied_funding?: Num;
  };
}

export type PerfRange = "1m" | "3m" | "ytd" | "1y" | "3y" | "max";

export interface PerfPoint {
  date: string;
  value: Num;
  contributions: Num;
  flow: Num;
  twr: Num;
  drawdown: Num;
  benchmark: Num;
  benchmark_drawdown: Num;
  simulated_value: Num;
  complete: boolean;
}

export interface PerfSummary {
  start_value: Num;
  end_value: Num;
  net_contributions: Num;
  deposits: Num;
  withdrawals: Num;
  implied_funding: Num;
  account_fees: Num;
  pnl: Num;
  twr: Num;
  twr_annualized: Num;
  xirr: Num;
  mwr: Num;
  max_drawdown: {
    depth: Num;
    peak: string | null;
    trough: string | null;
    recovered: string | null;
  } | null;
  days: number;
}

export interface Performance {
  as_of: string;
  base_currency: string;
  range: PerfRange;
  start: string;
  end: string;
  accounts_filter: number[] | null;
  step: "day" | "week" | "month";
  points: PerfPoint[];
  summary: PerfSummary | null;
  benchmark: {
    status: "ok" | "no_strategy" | "not_configured" | "proxy_not_found" | "no_prices" | string;
    message: string | null;
    id: string | null;
    proxy: string | null;
    instrument_id: number | null;
    currency: string | null;
    first_priced: string | null;
    covers_range: boolean | null;
    /** F7: the benchmark's last priced day and whether it reaches the range end (false: excess_* are null). */
    last_priced?: string | null;
    covers_range_end?: boolean | null;
    twr: Num;
    twr_annualized: Num;
    max_drawdown: {
      depth: Num;
      peak: string | null;
      trough: string | null;
      recovered: string | null;
    } | null;
    simulation: {
      end_value: Num;
      end_value_with_fees: Num;
      pnl: Num;
      xirr: Num;
      mwr: Num;
      started: string | null;
      capped: boolean | null;
    } | null;
    excess_twr: Num;
    excess_value: Num;
    excess_vs_simulation: Num;
  } | null;
  /** Caveats of the figures (`code` + `params`, Polish labels `perf.<code>` in core/messages.ts). */
  data_quality: {
    incomplete_days: number;
    end_complete: boolean;
    notes: { code: string; params?: Record<string, unknown> | null; message: string }[];
  } | null;
}

/** `stale`: a feed could not be refreshed (the last cache is shown); `errors`: `macro_unavailable`, `earnings_unavailable`, `offline`. */
export interface MarketCalendar {
  as_of: string;
  from: string;
  to: string;
  fetched_at: string | null;
  stale: boolean;
  errors: string[];
  events: CalendarEvent[];
}

// ---- ab24ab6 frontend/src/core/proposalsApi.ts -----------------------------------------------------------
export interface Backtest {
  evaluated?: number;
  step_days?: number;
  from?: string;
  to?: string;
  points_fired?: number;
  episodes?: number;
  first_fired?: string | null;
  last_fired?: string | null;
  instruments?: string[];
  points_skipped?: number;
  skip_reasons?: string[];
  note?: string;
}

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
