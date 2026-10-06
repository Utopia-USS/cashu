// Dev-only demo data for the v2 endpoints (`VITE_MOCK=1`), layered over the F3 investments mock
// (modules/investments/mock.ts): signal polarity + alert signals, alerts, the watchlist, 30-day closes,
// performance vs benchmark, the review digest with `since` + events, decision undo, signal snooze and the
// budget month close. Invented numbers only. Marta is the zero-start profile of the v2 design (one
// instrument, three deposits); `?marta=empty` keeps the empty F3 profile instead.
import { ApiError } from "../../../core/api";
import { investmentsMock } from "../mock";
import type { Alert, Performance, PerfPoint, PerfRange, PlannedDeposit, WatchItem } from "./api";
import { researchDigest, researchMock, researchSignals, researchUnread } from "./research/mock";

const TODAY = "2026-10-04";
const MINIMAL_MARTA = new URLSearchParams(typeof location !== "undefined" ? location.search : "").get("marta") !== "empty";
export const martaIsMinimal = () => MINIMAL_MARTA;

// ---- deterministic helpers ----------------------------------------------------------------------------
function walk(n: number, seed: number, start: number, drift: number, vol: number): number[] {
  let s = seed, v = start;
  const out: number[] = [];
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < n; i++) { out.push(v); v *= 1 + drift + (rnd() - 0.5) * vol; }
  return out;
}
const iso = (t: Date) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** 30 calendar days of weekday closes ending at `last` (TODAY's previous trading day), scaled to end at `last`. */
function closes30(last: number, seed: number, drift: number, vol = 0.025) {
  const days: string[] = [];
  const end = new Date(2026, 9, 3);
  for (let k = 29; k >= 0; k--) {
    const t = new Date(end.getTime() - k * 86400000);
    if (t.getDay() !== 0 && t.getDay() !== 6) days.push(iso(t));
  }
  const w = walk(days.length, seed, 100, drift, vol);
  const k = last / w[w.length - 1];
  return days.map((date, i) => ({ date, close: r2(w[i] * k) }));
}

// ---- per-profile v2 state -----------------------------------------------------------------------------
interface V2State {
  alerts: Alert[];
  watch: WatchItem[];
  alertSignals: Record<string, unknown>[];
  decisions: { id: number; signal_id: number; action: string; quantity: number | null; created_at: string; [k: string]: unknown }[];
  snoozed: Record<number, string>;
  undone: Set<number>;
  deletedReviews: Set<number>;
  /** F6: soft-deleted alerts (restore within 15 minutes keeps the id) and planned deposits. */
  deletedAlerts: { a: Alert; at: number }[];
  planned: PlannedDeposit[];
  nextId: number;
}
const states = new Map<string, V2State>();

const instRef = (id: number, label: string, symbol: string, currency = "PLN") => ({ id, label, symbol, name: label, isin: null, currency, asset_class: "equity", valuation_mode: "market" });

function alert(id: number, o: Partial<Alert> & Pick<Alert, "kind" | "title">): Alert {
  return {
    id, scope: "instrument", instrument_id: null, instrument: null, params: {}, unit: "price", polarity: "positive", severity: "info",
    note: null, source: "user", created_by: "app", status: "active", cooldown_days: 14, expires_at: null, snoozed_until: null,
    last_triggered_at: null, last_checked_at: `${TODAY}T07:02:00+02:00`, last_value: null, signal: null,
    created_at: "2026-08-01T10:00:00+02:00", updated_at: "2026-08-01T10:00:00+02:00", ...o,
  };
}

function janState(): V2State {
  return {
    nextId: 7000,
    snoozed: {},
    undone: new Set(),
    deletedReviews: new Set(),
    deletedAlerts: [],
    planned: [],
    decisions: [],
    alerts: [
      alert(801, { kind: "price_below", title: "EIMI poniżej 75,00 zł", instrument_id: 307, instrument: instRef(307, "iShares MSCI EM IMI", "EIMI"), params: { level: 75 }, severity: "action", source: "agent", created_by: "mcp", status: "triggered", last_triggered_at: "2026-10-02T07:02:00+02:00", last_value: 74.57, note: "Poziom dokupienia z tezy EM.", signal: { id: 951, status: "active", message: "", first_seen_at: "2026-10-02T07:02:00+02:00" } }),
      alert(802, { kind: "change_pct", title: "KGHM -10 % w 30 sesji", instrument_id: 305, instrument: instRef(305, "KGHM", "KGH"), params: { window_days: 30, threshold: 0.1, direction: "down" }, unit: "ratio", polarity: "negative", source: "agent", created_by: "mcp", status: "triggered", last_triggered_at: "2026-10-03T07:02:00+02:00", last_value: -0.124, signal: { id: 952, status: "active", message: "", first_seen_at: "2026-10-03T07:02:00+02:00" } }),
      alert(803, { kind: "price_below", title: "CDR poniżej 140,00 zł", instrument_id: 306, instrument: instRef(306, "CD Projekt", "CDR"), params: { level: 140 }, severity: "action", expires_at: "2026-12-31T00:00:00+01:00", last_value: 148.6, note: "Poziom dokupienia z tezy (transza 2)." }),
      alert(804, { kind: "price_below", title: "KGHM poniżej 135,00 zł", instrument_id: 305, instrument: instRef(305, "KGHM", "KGH"), params: { level: 135 }, severity: "action", last_value: 142.3 }),
      alert(805, { kind: "custom", title: "Gotówka poniżej 4 %", scope: "portfolio", params: { expression: "cash_weight < 4%" }, unit: "none", polarity: "negative", severity: "action", last_triggered_at: "2026-08-12T07:02:00+02:00" }),
      alert(806, { kind: "sma_cross", title: "VWRA: SMA 200 w dół", instrument_id: 301, instrument: instRef(301, "Vanguard FTSE All-World", "VWRA"), params: { window_days: 200, direction: "below" }, polarity: "negative", source: "agent", created_by: "mcp", last_value: 486.1 }),
      alert(807, { kind: "price_above", title: "CDR powyżej 201,80 zł", instrument_id: 306, instrument: instRef(306, "CD Projekt", "CDR"), params: { level: 201.8 }, polarity: "neutral", last_value: 148.6, note: "Plan wyjścia z tezy." }),
      alert(808, { kind: "price_below", title: "CSPX poniżej 560,00 $", instrument_id: 401, instrument: instRef(401, "iShares Core S&P 500", "CSPX", "USD"), params: { level: 560 }, status: "snoozed", snoozed_until: "2026-11-01T00:00:00+01:00", last_triggered_at: "2026-09-18T07:02:00+02:00", last_value: 612.4 }),
      alert(809, { kind: "weight_above", title: "Akcje powyżej 25 %", scope: "bucket", params: { threshold: 0.25, bucket: "stocks" }, unit: "ratio", polarity: "negative", status: "muted", last_triggered_at: "2026-09-14T07:02:00+02:00", last_value: 0.212 }),
      // F8 (home v3): a mixed subject (CDR: a chance from the rules + a risk from this alert), met alerts on watched
      // instruments (Obserwowane scope) and the two dynamic kinds (Q12) waiting.
      alert(810, { kind: "change_pct", title: "CDR -10 % w 30 sesji", instrument_id: 306, instrument: instRef(306, "CD Projekt", "CDR"), params: { window_days: 30, threshold: 0.1, direction: "down" }, unit: "ratio", polarity: "negative", status: "triggered", last_triggered_at: `${TODAY}T07:02:00+02:00`, last_value: -0.142, signal: { id: 953, status: "active", message: "", first_seen_at: `${TODAY}T07:02:00+02:00` } }),
      alert(811, { kind: "drawdown_from_high", title: "ALE: spadek 10 % od szczytu", instrument_id: 402, instrument: instRef(402, "Allegro", "ALE"), params: { window_days: 90, threshold: 0.1 }, unit: "ratio", polarity: "negative", source: "agent", created_by: "mcp", status: "triggered", last_triggered_at: "2026-10-03T07:02:00+02:00", last_value: 0.112, signal: { id: 954, status: "active", message: "", first_seen_at: "2026-10-03T07:02:00+02:00" } }),
      alert(812, { kind: "new_high", title: "XMME: nowy dołek 90 sesji", instrument_id: 403, instrument: instRef(403, "Xtrackers MSCI EM", "XMME", "EUR"), params: { window_days: 90, direction: "low" }, polarity: "positive", status: "triggered", last_triggered_at: "2026-10-01T07:02:00+02:00", last_value: 44.6, signal: { id: 955, status: "active", message: "", first_seen_at: "2026-10-01T07:02:00+02:00" } }),
      alert(813, { kind: "volume_spike", title: "CDR: wolumen 2,5x średniej", instrument_id: 306, instrument: instRef(306, "CD Projekt", "CDR"), params: { window_days: 20, multiple: 2.5 }, unit: "ratio", polarity: "neutral", source: "agent", created_by: "mcp", last_value: 1.2, note: "Po notatce o przesunięciu premiery.", state: { average_volume: 412000, volume: 494400, ratio: 1.2, window_days: 20 } }),
      alert(814, { kind: "range_breakout", title: "PKN: wybicie z konsolidacji 30 sesji", instrument_id: 304, instrument: instRef(304, "PKN Orlen", "PKN"), params: { window_days: 30, max_range_pct: 0.08, direction: "any" }, polarity: "neutral", last_value: 64.5, state: { range_low: 61.2, range_high: 66.0, range_pct: 0.0784, close: 64.5, currency: "PLN", window_days: 30 } }),
    ],
    watch: [
      watchItem(9101, 401, "iShares Core S&P 500", "CSPX", "USD", 612.4, 41, 0.0015, null, "user", { live: 1, triggered: 0, nearest: { alert_id: 808, kind: "price_below", title: "CSPX poniżej 560,00 $", level: 560, distance_pct: -0.0856 } }),
      watchItem(9102, 402, "Allegro", "ALE", "PLN", 32.15, 43, -0.002, "czekam na -10 % od szczytu", "agent", { live: 1, triggered: 1, nearest: { alert_id: 811, kind: "drawdown_from_high", title: "ALE: spadek 10 % od szczytu", level: null, distance_pct: null } }),
      watchItem(9103, 403, "Xtrackers MSCI EM", "XMME", "EUR", 44.6, 47, -0.001, null, "user", { live: 1, triggered: 1, nearest: { alert_id: 812, kind: "new_high", title: "nowy dołek 90 sesji", level: null, distance_pct: null } }),
      watchItem(9104, 404, "LPP", "LPP", "PLN", 16980, 53, 0.001, null, "user", { live: 0, triggered: 0, nearest: null }),
    ],
    alertSignals: [
      { id: 951, rule_id: "alert:801", kind: "alert:price_below", dedup_key: "alert:801", severity: "action", status: "active", polarity: "positive", source: "alert", alert_id: 801, message: "EIMI poniżej 75,00 zł: closed at 74.57 PLN", instrument_id: 307, instrument_label: "iShares MSCI EM IMI", account_id: null, payload: { alert_kind: "price_below", symbol: "EIMI", level: "75", close: "74.57", currency: "PLN", title: "EIMI poniżej 75,00 zł" }, first_seen_at: "2026-10-02T07:02:00+02:00", last_seen_at: `${TODAY}T07:02:00+02:00`, acknowledged_at: null, closed_at: null, decisions: [] },
      { id: 952, rule_id: "alert:802", kind: "alert:change_pct", dedup_key: "alert:802", severity: "info", status: "active", polarity: "negative", source: "alert", alert_id: 802, message: "KGHM -10 % w 30 sesji: fell 12.4%", instrument_id: 305, instrument_label: "KGHM", account_id: null, payload: { alert_kind: "change_pct", symbol: "KGH", change: -0.124, threshold: 0.1, window_days: 30, direction: "down" }, first_seen_at: "2026-10-03T07:02:00+02:00", last_seen_at: "2026-10-03T07:02:00+02:00", current: false, acknowledged_at: null, closed_at: null, decisions: [] },
      { id: 953, rule_id: "alert:810", kind: "alert:change_pct", dedup_key: "alert:810", severity: "action", status: "active", polarity: "negative", source: "alert", alert_id: 810, message: "CDR -10 % w 30 sesji: fell 14.2%", instrument_id: 306, instrument_label: "CD Projekt", account_id: null, payload: { alert_kind: "change_pct", symbol: "CDR", change: -0.142, threshold: 0.1, window_days: 30, direction: "down" }, first_seen_at: `${TODAY}T07:02:00+02:00`, last_seen_at: `${TODAY}T07:02:00+02:00`, current: true, acknowledged_at: null, closed_at: null, decisions: [] },
      { id: 954, rule_id: "alert:811", kind: "alert:drawdown_from_high", dedup_key: "alert:811", severity: "info", status: "active", polarity: "negative", source: "alert", alert_id: 811, message: "ALE: spadek 10 % od szczytu", instrument_id: 402, instrument_label: "Allegro", account_id: null, payload: { alert_kind: "drawdown_from_high", symbol: "ALE", drawdown: 0.112, threshold: 0.1, window_days: 90 }, first_seen_at: "2026-10-03T07:02:00+02:00", last_seen_at: `${TODAY}T07:02:00+02:00`, current: true, acknowledged_at: null, closed_at: null, decisions: [] },
      { id: 955, rule_id: "alert:812", kind: "alert:new_high", dedup_key: "alert:812", severity: "info", status: "active", polarity: "positive", source: "alert", alert_id: 812, message: "XMME: nowy dołek 90 sesji", instrument_id: 403, instrument_label: "Xtrackers MSCI EM", account_id: null, payload: { alert_kind: "new_high", symbol: "XMME", close: "44.60", currency: "EUR", window_days: 90, direction: "low" }, first_seen_at: "2026-10-01T07:02:00+02:00", last_seen_at: `${TODAY}T07:02:00+02:00`, current: true, acknowledged_at: null, closed_at: null, decisions: [] },
      { id: 905, rule_id: "global_below", kind: "allocation_drift", dedup_key: "global_below", severity: "info", status: "active", polarity: "neutral", source: "rule", alert_id: null, message: "global equity below target", instrument_id: null, instrument_label: null, account_id: null, payload: { bucket_id: "global_equity", bucket_generic: true, weight: 0.57, target: 0.6, drift_pp: -3.0, drift_value_base: "-5590", currency: "PLN", absolute_band_pp: 5, relative_band: 0.05 }, first_seen_at: `${TODAY}T07:02:00+02:00`, last_seen_at: `${TODAY}T07:02:00+02:00`, acknowledged_at: null, closed_at: null, decisions: [] },
      // F7-generic: a drift of an owner's own bucket (non-generic id): the server sends it, the app never shows it
      // (lists, counts, links); the agent sees it over MCP.
      { id: 906, rule_id: "own_bucket_drift", kind: "allocation_drift", dedup_key: "own_bucket_drift", severity: "action", status: "active", polarity: "negative", source: "rule", alert_id: null, message: "bucket active above target", instrument_id: null, instrument_label: null, account_id: null, payload: { bucket_id: "active", bucket_generic: false, weight: 0.31, target: 0.2, drift_pp: 11.0, drift_value_base: "20500", currency: "PLN", absolute_band_pp: 5, relative_band: 0.25 }, first_seen_at: `${TODAY}T07:02:00+02:00`, last_seen_at: `${TODAY}T07:02:00+02:00`, acknowledged_at: null, closed_at: null, decisions: [] },
    ],
  };
}

function watchItem(id: number, instId: number, name: string, symbol: string, currency: string, last: number, seed: number, drift: number, note: string | null, source: string, alerts: WatchItem["alerts"]): WatchItem {
  const c = closes30(last, seed, drift);
  return {
    id, instrument_id: instId, note, tags: [], source, added_at: "2026-08-20T10:00:00+02:00", held: false, price_source: true,
    instrument: { id: instId, symbol, name, label: name, isin: null, mic: null, currency, asset_class: "equity", region: null, sector: null, tags: [], valuation_mode: "market", status: "active", needs_classification: false, aliases: [] },
    price: { close: last, date: c[c.length - 1].date, currency, stale: false, change_1d: 0.004, change_1m: c[0].close ? last / c[0].close - 1 : null, high_52w: last * 1.08, high_52w_date: "2026-07-14", from_high_52w: -0.074, bars: 250 },
    closes_30d: c,
    alerts: { count: alerts.live, ...alerts },
  };
}

function stateFor(slug: string): V2State {
  let st = states.get(slug);
  if (!st) {
    st = slug === "jan" ? janState() : { alerts: [], watch: [], alertSignals: [], decisions: [], snoozed: {}, undone: new Set(), deletedReviews: new Set(), deletedAlerts: [], planned: [], nextId: 8000 };
    states.set(slug, st);
  }
  return st;
}

// ---- performance ----------------------------------------------------------------------------------------
const RANGE_DAYS: Record<PerfRange, number> = { "1m": 30, "3m": 91, ytd: 277, "1y": 365, "3y": 1095, max: 1095 };

function perfJan(range: PerfRange): Performance {
  const days = RANGE_DAYS[range];
  const step = days <= 400 ? (days <= 91 ? 1 : 7) : 7;
  const n = Math.floor(days / step) + 1;
  const end = new Date(2026, 9, 4);
  const dates = Array.from({ length: n }, (_, i) => iso(new Date(end.getTime() - (n - 1 - i) * step * 86400000)));
  // TWR index paths for the portfolio and the benchmark, anchored so the last year matches the design facts.
  const pIdx = walk(n, 11, 1, 0.14 / (365 / step), 0.028 * Math.sqrt(step / 7));
  const bIdx = walk(n, 23, 1, 0.07 / (365 / step), 0.022 * Math.sqrt(step / 7));
  const endValue = 186401.2;
  const values: number[] = new Array(n);
  const sim: number[] = new Array(n);
  const flows: number[] = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const d = dates[i];
    const prev = i ? dates[i - 1] : d;
    // monthly deposit of 2 000 zl on the 10th (none in May and September 2026)
    const crossed = i > 0 && d.slice(8) >= "10" && (prev.slice(0, 7) !== d.slice(0, 7) || prev.slice(8) < "10");
    if (crossed && !["2026-05", "2026-09"].includes(d.slice(0, 7))) flows[i] = 2000;
  }
  // Build values backwards from the end value with the index returns and the flows.
  values[n - 1] = endValue;
  sim[n - 1] = endValue * 0.98508;
  for (let i = n - 1; i > 0; i--) {
    values[i - 1] = (values[i] - flows[i]) * (pIdx[i - 1] / pIdx[i]);
    sim[i - 1] = (sim[i] - flows[i]) * (bIdx[i - 1] / bIdx[i]);
  }
  sim[0] = values[0];
  for (let i = 1; i < n; i++) sim[i] = sim[i - 1] * (bIdx[i] / bIdx[i - 1]) + flows[i];
  const twr = pIdx.map((v) => v / pIdx[0] - 1);
  const bench = bIdx.map((v) => v / bIdx[0] - 1);
  let peak = -Infinity;
  const dd = pIdx.map((v) => { peak = Math.max(peak, v); return v / peak - 1; });
  let contrib = values[0];
  const points: PerfPoint[] = dates.map((date, i) => {
    contrib += flows[i];
    return { date, value: r2(values[i]), contributions: r2(contrib), flow: flows[i], twr: twr[i], drawdown: dd[i], benchmark: bench[i], benchmark_drawdown: null, simulated_value: r2(sim[i]), complete: true };
  });
  const minDd = Math.min(...dd);
  const troughAt = dd.indexOf(minDd);
  const trough = dates[troughAt];
  const recoveredAt = dd.findIndex((v, i) => i > troughAt && v >= -1e-9);
  const recovered = recoveredAt > 0 ? dates[recoveredAt] : null;
  const deposits = flows.reduce((a, b) => a + b, 0);
  return {
    as_of: TODAY, base_currency: "PLN", range, start: dates[0], end: dates[n - 1], accounts_filter: null, step: step === 1 ? "day" : "week", points,
    summary: {
      start_value: r2(values[0]), end_value: endValue, net_contributions: deposits, deposits, withdrawals: 0, implied_funding: 0, account_fees: 61.2,
      pnl: r2(endValue - values[0] - deposits), twr: twr[n - 1], twr_annualized: days >= 365 ? twr[n - 1] / (days / 365) : null,
      xirr: days >= 365 ? 0.098 : null, mwr: 0.091, max_drawdown: { depth: minDd, peak: dates[Math.max(0, troughAt - 6)], trough, recovered }, days,
    },
    benchmark: {
      status: "ok", message: null, id: "msci_acwi", proxy: "SSAC.L", instrument_id: 501, currency: "USD", first_priced: "2019-01-02", covers_range: true,
      twr: bench[n - 1], twr_annualized: null, max_drawdown: null,
      simulation: { end_value: r2(sim[n - 1]), end_value_with_fees: r2(sim[n - 1] - 61.2), pnl: null, xirr: 0.087, mwr: null, started: dates[0], capped: false },
      excess_twr: twr[n - 1] - bench[n - 1], excess_value: r2(endValue - sim[n - 1]), excess_vs_simulation: endValue / sim[n - 1] - 1,
    },
    data_quality: { incomplete_days: 0, end_complete: true, notes: [] },
  };
}

function perfMarta(range: PerfRange): Performance {
  // Three deposits of 500 zl (10.07, 10.08, 10.09) into one ETF; October's is still due.
  const dates = ["2026-07-10", "2026-07-24", "2026-08-10", "2026-08-24", "2026-09-10", "2026-09-21", "2026-10-02", "2026-10-04"];
  const flows = [500, 0, 500, 0, 500, 0, 0, 0];
  const values = [500, 503.1, 1006.8, 1012.5, 1509.2, 1516.9, 1526.3, 1530.4];
  let c = 0;
  const points: PerfPoint[] = dates.map((date, i) => {
    c += flows[i];
    const r = values[i] / Math.max(1, c) - 1;
    return { date, value: values[i], contributions: c, flow: flows[i], twr: r, drawdown: 0, benchmark: r * 0.8, benchmark_drawdown: null, simulated_value: r2(c * (1 + r * 0.8)), complete: true };
  });
  return {
    as_of: TODAY, base_currency: "PLN", range, start: dates[0], end: TODAY, accounts_filter: null, step: "day", points,
    summary: { start_value: 0, end_value: 1530.4, net_contributions: 1500, deposits: 1500, withdrawals: 0, implied_funding: 0, account_fees: 0, pnl: 30.4, twr: 0.0203, twr_annualized: null, xirr: null, mwr: 0.02, max_drawdown: { depth: -0.004, peak: "2026-08-24", trough: "2026-09-07", recovered: "2026-09-10" }, days: 86 },
    benchmark: { status: "ok", message: null, id: "msci_acwi", proxy: "SSAC.L", instrument_id: 501, currency: "USD", first_priced: "2019-01-02", covers_range: true, twr: 0.016, twr_annualized: null, max_drawdown: null, simulation: { end_value: 1524, end_value_with_fees: 1524, pnl: 24, xirr: null, mwr: null, started: dates[0], capped: false }, excess_twr: 0.0043, excess_value: 6.4, excess_vs_simulation: 0.004 },
    data_quality: { incomplete_days: 0, end_complete: true, notes: [] },
  };
}

// ---- Marta (zero start, one ETF) ---------------------------------------------------------------------------
const MARTA_INST = { id: 601, symbol: "VWCE", name: "Vanguard FTSE All-World (Acc)", label: "Vanguard FTSE All-World (Acc)", isin: "IE00BK5BQT80", mic: "XETR", currency: "PLN", asset_class: "etf", region: "global", sector: null, tags: ["global_equity"], valuation_mode: "market", status: "active", needs_classification: false, aliases: [] };
function martaPositions() {
  const value = 1500 * 1.0203 - 0.04;
  return {
    as_of: TODAY, base_currency: "PLN", total: 1530.4,
    positions: [{
      instrument: MARTA_INST, bucket: "global_equity", quantity: 3.2, price: 478.25, price_date: "2026-10-03", price_currency: "PLN", is_stale: false, valuation_mode: "market", missing_fx_currency: null,
      value: r2(value), cost: 1500, unrealized: r2(value - 1500), unrealized_pct: (value - 1500) / 1500, weight: value / 1530.4, realized: null, dividends: {},
      accounts: [{ account_id: 121, account_name: "XTB IKE", quantity: 3.2, average_cost: 468.75, cost_currency: "PLN", value: r2(value), cost: 1500, unrealized_pct: (value - 1500) / 1500, weight: value / 1530.4 }],
      lots: [], open_signals: 0, has_thesis: false, closes_30d: closes30(478.25, 61, 0.001, 0.015),
    }],
    cash: [{ account_id: 121, account_name: "XTB IKE", currency: "PLN", amount: 0.4, amount_base: 0.4 }],
  };
}
function martaOverview() {
  return {
    as_of: TODAY, base_currency: "PLN", accounts_filter: null,
    kpis: {
      value: { total: 1530.4, holdings: 1530, cash: 0.4 }, unrealized: { amount: 30, pct: 0.02, cost: 1500 }, cash: { amount: 0.4, weight: 0.0003, accounts: 1 },
      signals: { action: 0, info: 0, new: 0 }, polarity: { positive: 0, negative: 0, neutral: 0 },
      alerts: { active: 0, triggered: 0, snoozed: 0, muted: 0, expired: 0, agent_live: 0 },
      max_drift: null, out_of_band: 0, last_run: { id: 5, trigger: "worker", as_of: TODAY, status: "ok", started_at: `${TODAY}T07:01:40+02:00`, finished_at: `${TODAY}T07:02:00+02:00`, errors: [], stats: {}, new_signal_ids: [], escalated_signal_ids: [] }, realized: null,
    },
    allocation: { base_currency: "PLN", total: 1530.4, has_strategy: false, buckets: [], unclassified: null, unallocated_cash: null, by_asset_class: [{ key: "etf", value: 1530, weight: 1 }], by_region: [{ key: "global", value: 1530, weight: 1 }], band: null },
    freshness: { prices: { newest_bar: "2026-10-03", stale: [], stale_count: 0, stale_weight: 0 }, fx: { newest_rate: "2026-10-03", missing: [] }, strategy: { state: "missing", version: null, changed: false, errors: 0, warnings: 0, inactive_rules: 0 } },
    warnings: [],
    accounts: [{ id: 121, name: "XTB IKE", broker: "xtb", broker_name: "XTB", wrapper: "ike", currency: "PLN", importer: null, has_mapping: false, value: 1530.4, share: 1, snapshot_date: null, last_import: null }],
    attention: [], attention_total: 0,
  };
}

// ---- digest events ----------------------------------------------------------------------------------------
function janEvents(since: string) {
  const ev = [
    { type: "alert_triggered", at: "2026-10-03T07:02:00+02:00", date: "2026-10-03", polarity: "negative", alert_id: 802, instrument_label: "KGHM", message: "KGHM -10 % w 30 sesji", kind: "alert:change_pct",
      message_code: "alert.change_pct", message_params: { title: "KGHM -10 % w 30 sesji", label: "KGH", window_days: 30, change: 0.124, direction: "down", threshold: 0.1, close: "142.30", date: "2026-10-02" } },
    { type: "alert_triggered", at: "2026-10-02T07:02:00+02:00", date: "2026-10-02", polarity: "positive", alert_id: 801, instrument_label: "iShares MSCI EM IMI", message: "EIMI poniżej 75,00 zł", kind: "alert:price_below" },
    { type: "import", at: "2026-10-01T19:02:00+02:00", date: "2026-10-01", file_name: "dif_2026-10-01.csv", inserted: 6, account_id: 21 },
    { type: "signal_created", at: "2026-09-29T07:02:00+02:00", date: "2026-09-29", polarity: "positive", kind: "drawdown_from_high", instrument_label: "CD Projekt", message: "" },
    { type: "signal_created", at: "2026-09-21T07:02:00+02:00", date: "2026-09-21", polarity: "negative", kind: "contribution_gap", message: "" },
    { type: "signal_created", at: "2026-09-15T07:02:00+02:00", date: "2026-09-15", polarity: "neutral", kind: "allocation_drift", message: "", instrument_label: null, bucket_id: "stocks" },
    { type: "decision", at: "2026-09-14T20:00:00+02:00", date: "2026-09-14", action: "held", instrument_label: null, reason: "rebalans przy wpłacie" },
    { type: "signal_resolved", at: "2026-08-24T07:02:00+02:00", date: "2026-08-24", polarity: "neutral", kind: "gain_from_cost", instrument_label: "KGHM", status: "expired", message: "" },
    { type: "deposit", at: "2026-08-10T00:00:00+02:00", date: "2026-08-10", amount: 2000, currency: "PLN", account_id: 22 },
    { type: "data_warning", at: "2026-08-03T07:02:00+02:00", date: "2026-08-03", message: "stooq: 1 price source did not answer", count: 1 },
    { type: "deposit", at: "2026-07-10T00:00:00+02:00", date: "2026-07-10", amount: 2000, currency: "PLN", account_id: 22 },
  ];
  return ev.filter((e) => e.date >= since);
}

// ---- router -------------------------------------------------------------------------------------------------
type Kind = "full" | "empty";
const isOpen = (s: { status: string }) => s.status === "active" || s.status === "acknowledged";

/** Handles the v2 paths (or decorates the F3 mock's answer); `path` is after /api/p/{slug}. */
export function investmentsV2Mock(slug: string, kind: Kind, path: string, q: URLSearchParams, method: string, body: unknown): unknown {
  const st = stateFor(slug);
  const b = (body ?? {}) as Record<string, unknown>;
  const minimal = kind === "empty" && MINIMAL_MARTA;
  const base = () => investmentsMock(slug, kind, path, q, method, body);
  const ip = path.startsWith("/investments") ? path.slice("/investments".length) : null;

  if (path === "/budget/month-close") return monthClose(slug, q.get("month"));
  const rv = /^\/reviews\/(\d+)$/.exec(path);
  if (rv && method === "DELETE") { st.deletedReviews.add(Number(rv[1])); return { deleted: Number(rv[1]) }; }
  if (path === "/reviews" && method === "GET") return (base() as { id: number }[]).filter((r) => !st.deletedReviews.has(r.id));
  if (ip == null) return base();
  if (ip.startsWith("/research")) {
    return researchMock(slug, kind, ip, q, method, body, {
      add: (symbol, name, note) => { const w = watchItem(st.nextId++, st.nextId++, name, symbol, "PLN", 100, st.nextId, 0.001, note, "user", { live: 0, triggered: 0, nearest: null }); st.watch.push(w); return w.id; },
      remove: (id) => { st.watch = st.watch.filter((w) => w.id !== id); },
    });
  }

  if (minimal) {
    if (ip === "/overview") return martaOverview();
    if (ip === "/positions") return martaPositions();
    if (ip === "/signals") return [];
    if (ip === "/review-digest") return { ...(base() as object), events: [], events_total: 0 };
  }
  if (ip === "/performance") {
    const range = (q.get("range") ?? "1y") as PerfRange;
    if (kind === "empty" && !minimal) return { ...perfMarta(range), points: [], summary: null };
    return kind === "full" ? perfJan(range) : perfMarta(range);
  }
  if (ip === "/alert-kinds") throw new ApiError(404, "Not Found"); // the form falls back to its static catalog
  if (ip === "/alerts" && method === "GET") {
    const want = q.get("status") ?? "all";
    return st.alerts.filter((a) => want === "all" || want.split(",").includes(a.status) || (want === "live" && ["active", "triggered", "snoozed"].includes(a.status)));
  }
  if (ip === "/alerts" && method === "POST") {
    const a = alert(st.nextId++, { ...(b as Partial<Alert>), kind: String(b.kind), title: String(b.title), source: "user", status: "active", instrument: null, created_at: new Date().toISOString() });
    if (b.expires_in_days) a.expires_at = new Date(Date.now() + Number(b.expires_in_days) * 86400000).toISOString();
    st.alerts.unshift(a);
    return a;
  }
  let m = /^\/alerts\/(\d+)\/restore$/.exec(ip);
  if (m && method === "POST") {
    const k = st.deletedAlerts.findIndex((x) => x.a.id === Number(m![1]));
    if (k < 0) throw new ApiError(404, "No deleted alert", "not_found");
    if (Date.now() - st.deletedAlerts[k].at > 15 * 60000) throw new ApiError(409, "The undo window has passed", "undo_expired");
    const [{ a }] = st.deletedAlerts.splice(k, 1);
    st.alerts.unshift(a);
    return a;
  }
  m = /^\/alerts\/(\d+)$/.exec(ip);
  if (m) {
    const a = st.alerts.find((x) => x.id === Number(m![1]));
    if (!a) throw new ApiError(404, "No alert", "not_found");
    if (method === "DELETE") { st.alerts = st.alerts.filter((x) => x !== a); st.deletedAlerts.push({ a, at: Date.now() }); st.alertSignals = st.alertSignals.filter((s) => s.alert_id !== a.id); return { deleted: a.id }; }
    const patch = { ...b };
    if (patch.status === "snoozed") patch.snoozed_until = new Date(Date.now() + Number(patch.snooze_days ?? 7) * 86400000).toISOString();
    delete patch.snooze_days;
    if (patch.status === "muted" || patch.status === "snoozed") st.alertSignals = st.alertSignals.filter((s) => s.alert_id !== a.id);
    Object.assign(a, patch, { updated_at: new Date().toISOString() });
    return a;
  }
  if (ip === "/watchlist" && method === "GET") return st.watch.map((w) => ({ ...w, research_unread: researchUnread(slug, kind, w.instrument_id) }));
  if (ip === "/watchlist" && method === "POST") {
    const sym = String(b.symbol_or_isin ?? "").trim().toUpperCase();
    if (!sym) throw new ApiError(422, "symbol_or_isin is required", "watchlist_invalid");
    if (st.watch.some((w) => w.instrument?.symbol === sym)) throw new ApiError(409, `${sym} is already on the watchlist`, "watchlist_conflict");
    const w = watchItem(st.nextId++, st.nextId++, sym, sym.replace(/\..*$/, ""), "PLN", 100, st.nextId, 0.001, (b.note as string) ?? null, "user", { live: 0, triggered: 0, nearest: null });
    st.watch.push(w);
    return { ...w, created_instrument: true, warnings: [] };
  }
  m = /^\/watchlist\/(\d+)$/.exec(ip);
  if (m && method === "DELETE") { st.watch = st.watch.filter((w) => w.id !== Number(m![1])); return { deleted: Number(m[1]) }; }

  // F6 planned deposits: "Zaplanuj wpłatę" (never cash until an import books it).
  if (ip === "/planned-deposits" && method === "GET") {
    const items = st.planned.filter((p) => p.status !== "cancelled");
    const month = TODAY.slice(0, 7);
    const planned = items.filter((p) => p.status === "planned" && p.planned_date.startsWith(month)).reduce((a, p) => a + p.amount, 0);
    return { items, plan: { month, currency: "PLN", monthly_amount: 2000, day_of_month: 10, deposited: 0, planned, remaining: Math.max(0, 2000 - planned), covered: planned >= 2000, planned_count: items.length } };
  }
  if (ip === "/planned-deposits" && method === "POST") {
    const amount = Number(b.amount);
    if (!(amount > 0)) throw new ApiError(422, "amount must be positive", "planned_invalid");
    const p: PlannedDeposit = { id: st.nextId++, account_id: (b.account_id as number | null) ?? null, amount, currency: String(b.currency ?? "PLN"), planned_date: String(b.planned_date), note: (b.note as string | null) ?? null, status: "planned", booked_txn_id: null, booked_at: null, created_at: new Date().toISOString() };
    st.planned.push(p);
    return p;
  }
  m = /^\/planned-deposits\/(\d+)$/.exec(ip);
  if (m && method === "DELETE") {
    if (!st.planned.some((p) => p.id === Number(m![1]))) throw new ApiError(404, "No planned deposit", "not_found");
    st.planned = st.planned.filter((p) => p.id !== Number(m![1]));
    return { deleted: Number(m[1]) };
  }

  m = /^\/decisions\/(\d+)$/.exec(ip);
  if (m && method === "DELETE") {
    const id = Number(m[1]);
    st.undone.add(id);
    st.decisions = st.decisions.filter((d) => d.id !== id);
    return { deleted: id, signal: null };
  }
  m = /^\/signals\/(\d+)\/snooze$/.exec(ip);
  if (m) {
    const id = Number(m[1]);
    if (b.until) st.snoozed[id] = String(b.until); else delete st.snoozed[id];
    return { id, snoozed_until: b.until ?? null, snoozed: !!b.until };
  }
  m = /^\/signals\/(\d+)\/(decision|acknowledge)$/.exec(ip);
  if (m) {
    const id = Number(m[1]);
    const extra = st.alertSignals.find((s) => s.id === id);
    const d = { id: st.nextId++, signal_id: id, instrument_id: null, account_id: (b.account_id as number) ?? null, action: m[2] === "acknowledge" ? "held" : String(b.action), quantity: (b.quantity as number) ?? null, price: (b.price as number) ?? null, currency: (b.currency as string) ?? null, reason: (b.reason as string) ?? null, created_at: new Date().toISOString() };
    if (extra) {
      st.decisions.push(d);
      return { decision: d, signal: { ...extra, status: "acknowledged", decisions: st.decisions.filter((x) => x.signal_id === id) } };
    }
    return base();
  }

  const res = base();
  if (ip === "/signals") {
    const status = q.get("status") ?? "open";
    const list = (res as Record<string, unknown>[]).concat(st.alertSignals.filter((s) => status === "all" || (status === "open" ? isOpen(s as { status: string }) : !isOpen(s as { status: string }))))
      .concat(researchSignals(slug, kind, status));
    return list.map((s) => decorateSignal(s, st));
  }
  if (ip === "/overview") return decorateOverview(res as Record<string, unknown>, st, slug, kind);
  if (ip === "/positions") return decoratePositions(res as { positions: Record<string, unknown>[] }, (id) => researchUnread(slug, kind, id));
  if (ip === "/review-digest") {
    const since = q.get("since");
    const d = res as Record<string, unknown>;
    if (kind !== "full") return { ...d, events: [], events_total: 0 };
    const from = since ?? String(d.since);
    const ev = janEvents(from);
    return { ...d, research: researchDigest(slug, kind), since: from, baseline: since ? "since" : d.baseline, events: ev, events_total: ev.length, value: { ...(d.value as object), contributions: since ? 4000 : 0, market_change: since ? 6720 : (d.value as { change: number }).change } };
  }
  return res;
}

const DEFAULT_POL: Record<string, string> = { drawdown_from_high: "positive", gain_from_cost: "positive", allocation_drift: "neutral", position_concentration: "negative", contribution_gap: "negative", cash_level: "negative", loss_from_cost: "negative" };
function decorateSignal(s: Record<string, unknown>, st: V2State) {
  const id = s.id as number;
  const own = st.alertSignals.some((x) => x.id === id) ? st.decisions.filter((d) => d.signal_id === id) : [];
  const had = ((s.decisions as { id: number }[]) ?? []).concat(own as { id: number }[]);
  const decisions = had.filter((d) => !st.undone.has(d.id));
  const status = had.length && !decisions.length && s.status === "acknowledged" ? "active" : s.status;
  return {
    ...s, status, decisions,
    polarity: s.polarity ?? DEFAULT_POL[String(s.kind)] ?? "neutral",
    source: s.source ?? (String(s.rule_id).startsWith("alert:") ? "alert" : "rule"),
    alert_id: s.alert_id ?? null,
    snoozed_until: st.snoozed[id] ?? null,
    snoozed: !!st.snoozed[id],
    current: s.current ?? true,
  };
}

function decorateOverview(ov: Record<string, unknown>, st: V2State, slug: string, kind: Kind) {
  const signals = (investmentsMock(slug, kind, "/investments/signals", new URLSearchParams("status=open"), "GET", null) as Record<string, unknown>[])
    .concat(st.alertSignals).map((s) => decorateSignal(s, st));
  const pol = { positive: 0, negative: 0, neutral: 0 } as Record<string, number>;
  for (const s of signals) pol[String(s.polarity)] = (pol[String(s.polarity)] ?? 0) + 1;
  const counts = { active: 0, triggered: 0, snoozed: 0, muted: 0, expired: 0, agent_live: 0 } as Record<string, number>;
  for (const a of st.alerts) { counts[a.status] = (counts[a.status] ?? 0) + 1; if (a.source === "agent" && ["active", "triggered", "snoozed"].includes(a.status)) counts.agent_live++; }
  const kpis = ov.kpis as Record<string, unknown>;
  return { ...ov, kpis: { ...kpis, polarity: pol, alerts: counts }, attention: [], attention_total: signals.length };
}

const SEEDS: Record<number, [number, number]> = { 301: [3, 0.0012], 302: [4, 0.001], 303: [0, 0], 304: [9, 0.002], 305: [21, -0.0045], 306: [17, -0.006], 307: [31, -0.003] };
function decoratePositions(res: { positions: Record<string, unknown>[] }, unread: (instrumentId: number) => number) {
  return {
    ...res,
    positions: res.positions.map((p) => {
      const id = (p.instrument as { id: number }).id;
      const last = p.price as number;
      const [seed, drift] = SEEDS[id] ?? [id % 50, 0];
      const closes = p.valuation_mode === "cost"
        ? closes30(last, 1, 0, 0).map((c, i, all) => ({ ...c, close: r2(last * (1 - (all.length - 1 - i) * 0.0002)) }))
        : closes30(last, seed, drift, id === 306 ? 0.035 : 0.025);
      return { ...p, closes_30d: closes, research_unread: unread(id) };
    }),
  };
}

function monthClose(slug: string, month: string | null) {
  const m = month ?? "2026-09";
  if (slug !== "jan") throw new ApiError(404, "Not Found");
  return {
    month: m, complete: m < "2026-10", base_currency: "PLN", first_month: "2025-01", last_month: "2026-10",
    currencies: [{ currency: "PLN", income: 11240, spending: 8600, surplus: 2640, cushion_top_up: 0, suggested_transfer: 2640, transactions: 142,
      income_by_category: [{ category: "salary", label: "Wynagrodzenie", amount: 11240 }],
      spending_by_category: [{ category: "groceries", label: "Zakupy spożywcze", amount: 2140 }, { category: "housing", label: "Mieszkanie", amount: 1980 }] }],
    cushion: { enabled: true, currency: "PLN", target: 51600, target_source: "months", target_months: 6, average_spending: 8600, balance: 51980, missing: 0, top_up: 0, reached: true, accounts: [{ id: 2, name: "Konto oszczędnościowe" }] },
    investing: { enabled: true, strategy_state: "partial", planned: { amount: 2000, currency: "PLN", day_of_month: 10 }, comparison: { currency: "PLN", has_data: true, surplus: 2640, suggested_transfer: 2640, difference: 640, status: "covered" } },
  };
}
