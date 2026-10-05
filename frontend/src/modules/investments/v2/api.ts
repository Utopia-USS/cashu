// v2 additions to the investments client (F5 contracts): signal polarity / attention, alerts, the
// watchlist, 30-day closes, the review digest with `since` + events, decision undo, signal snooze
// (track AL, stock/docs/fork/progress/F5-AL.md) and performance vs benchmark (track PF, F5-PF.md
// CONTRACT). Shapes mirror service/views.py and performance/service.py; fractions stay fractions.
import { ApiError, j, jdel, jpatch, jpost, pp } from "../../../core/api";
import { ck, invalidate } from "../../../swr";
import type { Decision, Instrument, Overview, Position, Positions, ReviewDigest, Signal } from "../api";
import { digestShown, isShownSignal } from "./logic";

export type Polarity = "positive" | "negative" | "neutral";
export type Num = number | null;

export interface SignalV2 extends Signal {
  polarity?: Polarity | string;
  source?: "rule" | "alert" | string;
  alert_id?: number | null;
  snoozed_until?: string | null;
  snoozed?: boolean;
  /** Alert signals (F6 BE): `alert.<kind>` + params for the Polish fact (core/messages.ts); null for rules. */
  message_code?: string | null;
  message_params?: Record<string, unknown> | null;
}

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

export interface AlertCounts { active: number; triggered: number; snoozed: number; muted: number; expired: number; agent_live: number }

export interface OverviewV2 extends Overview {
  kpis: Overview["kpis"] & { polarity?: Record<Polarity, number>; alerts?: AlertCounts };
  attention?: AttentionItem[];
  attention_total?: number;
}

export interface Close { date: string; close: number }
export type PositionV2 = Position & { closes_30d?: Close[] };
export type PositionsV2 = Omit<Positions, "positions"> & { positions: PositionV2[] };

export interface Alert {
  id: number;
  kind: string;
  scope: "instrument" | "portfolio" | "bucket" | string;
  instrument_id: number | null;
  instrument: { id: number | string; label: string; symbol: string | null; name: string; isin: string | null; currency: string; asset_class: string; valuation_mode: string | null } | null;
  params: Record<string, unknown>;
  unit: "price" | "ratio" | "none" | string | null;
  polarity: Polarity | string;
  severity: "info" | "action" | string;
  title: string;
  note: string | null;
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
  created_at: string | null;
  updated_at: string | null;
}

export interface AlertParamInfo { name: string; type: "number" | "integer" | "text" | "choice" | string; required: boolean; doc: string; default: unknown; minimum: Num; maximum: Num; choices: string[] }
export interface AlertKindInfo { kind: string; scopes: string[]; doc: string; unit: string; params: AlertParamInfo[] }
export interface AlertKinds { kinds: AlertKindInfo[]; polarities: string[]; severities: string[]; statuses: string[] }

export interface AlertInput {
  kind: string;
  title: string;
  params: Record<string, unknown>;
  instrument_id?: number | null;
  scope?: string | null;
  polarity?: string | null;
  severity?: string | null;
  note?: string | null;
  cooldown_days?: number | null;
  expires_at?: string | null;
  expires_in_days?: number | null;
}
export type AlertPatch = Partial<Omit<AlertInput, "kind" | "instrument_id" | "scope">> & {
  status?: "active" | "snoozed" | "muted";
  snooze_days?: number | null;
  snoozed_until?: string | null;
};

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
    close: number; date: string; currency: string; stale: boolean; change_1d: Num; change_1m: Num;
    high_52w: Num; high_52w_date: string | null; from_high_52w: Num; bars: number;
  } | null;
  closes_30d?: Close[];
  alerts: { count?: number; live: number; triggered: number; nearest?: { alert_id: number; kind: string; title: string; level: Num; distance_pct: Num } | null };
}

export interface DigestEvent {
  type: "signal_created" | "alert_triggered" | "signal_escalated" | "signal_resolved" | "import" | "decision" | "deposit" | "withdrawal" | "data_warning" | string;
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
  events?: DigestEvent[];
  events_total?: number;
  /** F7 (V4): `market_change` excludes `transfers` (units moved in / out, adjustments, cash transfers) and
   * `implied_funding`; both reported separately (base currency, null when they cannot be valued). */
  value: ReviewDigest["value"] & { contributions?: Num; market_change?: Num; market_change_pct?: Num; transfers?: Num; implied_funding?: Num };
}

// ---- performance (PF) -----------------------------------------------------------------------------
export type PerfRange = "1m" | "3m" | "ytd" | "1y" | "3y" | "max";
export interface PerfPoint {
  date: string; value: Num; contributions: Num; flow: Num; twr: Num; drawdown: Num;
  benchmark: Num; benchmark_drawdown: Num; simulated_value: Num; complete: boolean;
}
export interface PerfSummary {
  start_value: Num; end_value: Num; net_contributions: Num; deposits: Num; withdrawals: Num; implied_funding: Num; account_fees: Num; pnl: Num;
  twr: Num; twr_annualized: Num; xirr: Num; mwr: Num;
  max_drawdown: { depth: Num; peak: string | null; trough: string | null; recovered: string | null } | null;
  days: number;
}
export interface Performance {
  as_of: string; base_currency: string; range: PerfRange; start: string; end: string; accounts_filter: number[] | null;
  step: "day" | "week" | "month";
  points: PerfPoint[];
  summary: PerfSummary | null;
  benchmark: {
    status: "ok" | "no_strategy" | "not_configured" | "proxy_not_found" | "no_prices" | string;
    message: string | null; id: string | null; proxy: string | null; instrument_id: number | null; currency: string | null;
    first_priced: string | null; covers_range: boolean | null;
    /** F7: the benchmark's last priced day and whether it reaches the range end (false: excess_* are null). */
    last_priced?: string | null; covers_range_end?: boolean | null;
    twr: Num; twr_annualized: Num; max_drawdown: { depth: Num; peak: string | null; trough: string | null; recovered: string | null } | null;
    simulation: { end_value: Num; end_value_with_fees: Num; pnl: Num; xirr: Num; mwr: Num; started: string | null; capped: boolean | null } | null;
    excess_twr: Num; excess_value: Num; excess_vs_simulation: Num;
  } | null;
  /** Caveats of the figures (`code` + `params`, Polish labels `perf.<code>` in core/messages.ts). */
  data_quality: { incomplete_days: number; end_complete: boolean; notes: { code: string; params?: Record<string, unknown> | null; message: string }[] } | null;
}

// ---- endpoints ------------------------------------------------------------------------------------
const inv = (slug: string, path: string) => pp(slug, `/investments${path}`);
const qs = (accounts: number[] | null) => (accounts && accounts.length ? `accounts=${accounts.join(",")}` : "");

// The overview is read by the Przegląd hero, the Inwestycje widget and the surplus card on one page:
// one request per profile and filter within a few seconds.
const cache = new Map<string, { at: number; p: Promise<unknown> }>();
function cached<T>(key: string, load: () => Promise<T>, ms = 4000): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.p as Promise<T>;
  const p = load();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}

// ---- stale-while-revalidate keys (F7 PX4, src/swr.ts) ----------------------------------------------------------
/** Cache key of an investments view: under `inv`, so `dropInv` forgets all of them at once. Two call sites share a
 * key only when they fetch AND shape the data the same way (signals: the shown list, `isShownSignal` applied in
 * the loader, so the cache never holds an unfiltered list). */
export const invKey = (slug: string, ...parts: (string | number | boolean | null | undefined)[]) => ck(slug, "inv", ...parts);
/** The account filter as a key part. */
export const accKey = (accounts: number[] | null | undefined) => (accounts?.length ? accounts.join(",") : "");
/** After an investments write that does not go through ctx.refresh: every cached investments view (the views on
 * screen keep showing their data and re-read) and the 4 s request dedupe. */
export function dropInv(slug: string): void {
  cache.clear();
  invalidate(ck(slug, "inv"));
}
export const dropCache = () => cache.clear();

export const getOverviewV2 = (slug: string, accounts: number[] | null = null) =>
  cached(`ov:${slug}:${qs(accounts)}`, () => j<OverviewV2>(inv(slug, `/overview${accounts?.length ? `?${qs(accounts)}` : ""}`)));
export const getPositionsV2 = (slug: string, accounts: number[] | null = null) =>
  j<PositionsV2>(inv(slug, `/positions${accounts?.length ? `?${qs(accounts)}` : ""}`));
/** Signals as the app shows them: an allocation drift of the owner's own (non-generic) bucket never reaches a list,
 * a count or a link (F7-generic, `isShownSignal`); the agent still sees it over MCP. */
export const getSignalsV2 = (slug: string, status: "open" | "history" | "all" = "open") =>
  j<SignalV2[]>(inv(slug, `/signals?status=${status}`)).then((list) => list.filter(isShownSignal));
export const getDigestV2 = (slug: string, since?: string | null) =>
  j<DigestV2>(inv(slug, `/review-digest${since ? `?since=${since}` : ""}`)).then(digestShown);

/** Performance vs benchmark; null when the server has no performance endpoint yet (404). */
export const getPerformance = (slug: string, range: PerfRange, accounts: number[] | null = null): Promise<Performance | null> =>
  cached(`perf:${slug}:${range}:${qs(accounts)}`, async () => {
    try {
      return await j<Performance>(inv(slug, `/performance?range=${range}${accounts?.length ? `&${qs(accounts)}` : ""}`));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && /not found/i.test(e.message)) return null;
      throw e;
    }
  }, 15000);

export const getAlerts = (slug: string, status = "all") => j<Alert[]>(inv(slug, `/alerts?status=${status}`));
export const getAlertKinds = (slug: string) => cached(`kinds:${slug}`, () => j<AlertKinds>(inv(slug, "/alert-kinds")), 600000);
export const postAlert = (slug: string, b: AlertInput) => jpost<Alert>(inv(slug, "/alerts"), b);
export const patchAlert = (slug: string, id: number, b: AlertPatch) => jpatch<Alert>(inv(slug, `/alerts/${id}`), b);
export const deleteAlert = (slug: string, id: number) => jdel<{ deleted: number }>(inv(slug, `/alerts/${id}`));
/** Undo of a delete within 15 minutes (F6 BE: soft delete + restore, the id stays). */
export const restoreAlert = (slug: string, id: number) => jpost<Alert>(inv(slug, `/alerts/${id}/restore`));

export const getWatchlist = (slug: string) => j<WatchItem[]>(inv(slug, "/watchlist"));
export const postWatch = (slug: string, b: { symbol_or_isin?: string; instrument_id?: number; note?: string | null; currency?: string | null; tags?: string[] | null }) =>
  jpost<WatchItem & { created_instrument: boolean; warnings: string[]; warning_codes?: { code: string; params: Record<string, unknown> | null; message: string }[] }>(inv(slug, "/watchlist"), b);
export const deleteWatch = (slug: string, id: number) => jdel<{ deleted: number }>(inv(slug, `/watchlist/${id}`));

// ---- planned deposits (F6 BE: `inv_planned_deposits`; "Zaplanuj wpłatę" on Przegląd and the minimal view) --
/** A planned deposit: counted against the contribution plan, never as cash until an import books it. */
export interface PlannedDeposit {
  id: number;
  account_id: number | null;
  amount: number;
  currency: string;
  planned_date: string;
  note: string | null;
  status: "planned" | "booked" | "cancelled" | string;
  booked_txn_id: number | null;
  booked_at: string | null;
  created_at: string | null;
}
export interface PlannedDepositInput { amount: number; currency: string; planned_date: string; account_id?: number | null; note?: string | null }
type RawPlanned = Omit<PlannedDeposit, "amount"> & { amount: number | string };
const normPlanned = (r: RawPlanned): PlannedDeposit => ({ ...r, amount: Number(r.amount) });
/** The month's contribution-plan progress in the base currency (amounts null when an FX rate is missing). */
export interface MonthPlan {
  month: string; currency: string; monthly_amount: Num; day_of_month: number | null;
  deposited: Num; planned: Num; remaining: Num; covered: boolean | null; planned_count: number;
}
export interface PlannedList { items: PlannedDeposit[]; plan: MonthPlan | null }
export const getPlannedDeposits = async (slug: string): Promise<PlannedList> => {
  const r = await j<RawPlanned[] | { items: RawPlanned[]; plan?: MonthPlan | null }>(inv(slug, "/planned-deposits"));
  return Array.isArray(r) ? { items: r.map(normPlanned), plan: null } : { items: (r.items ?? []).map(normPlanned), plan: r.plan ?? null };
};
export const postPlannedDeposit = async (slug: string, b: PlannedDepositInput): Promise<PlannedDeposit> =>
  normPlanned(await jpost<RawPlanned>(inv(slug, "/planned-deposits"), b));
export const deletePlannedDeposit = (slug: string, id: number) => jdel<{ deleted: number }>(inv(slug, `/planned-deposits/${id}`));

// Decision undo (DELETE /decisions/{id}), snooze and review undo live in ../api.ts (FX, F5 R4 / R7).
export const getDecisionsFor = (slug: string, instrumentId: number | string) => j<Decision[]>(inv(slug, `/decisions?instrument_id=${instrumentId}`));
