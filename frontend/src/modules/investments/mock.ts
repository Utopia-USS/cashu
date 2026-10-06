// Dev-only demo data of the investments workspace (`VITE_MOCK=1`), plugged into core/mock.ts.
// Invented numbers only: a profile with history (three accounts, seven instruments, strategy v7,
// signals, a pending agent proposal) and a fresh profile with one account and nothing else.
// Implements the investments API plus track M's reviews / proposals contract in memory.
import { ApiError } from "../../core/api";
import type {
  AccountRow, Batch, Decision, ImportPreview, Instrument, Overview, Position, PositionChart, PositionDetail, Positions,
  Proposal, Review, ReviewDigest, Signal, StrategyStatus, Thesis, Txn,
} from "./api";

const TODAY = "2026-10-04";
const NOW = "2026-10-04T09:12:00+02:00";

type Kind = "full" | "empty";
interface State {
  kind: Kind;
  accounts: AccountRow[];
  instruments: Instrument[];
  holdings: { inst: number; acc: number; qty: number; cost: number; price: number; date: string; bucket: string | null; stale?: boolean; mode?: string }[];
  cash: { acc: number; amount: number }[];
  signals: Signal[];
  decisions: Decision[];
  theses: Thesis[];
  reviews: Review[];
  proposals: Proposal[];
  strategyVersion: number | null;
  imports: Batch[];
  manual: Txn[];
  nextId: number;
}

const inst = (id: number, symbol: string, name: string, extra: Partial<Instrument> = {}): Instrument => ({
  id, symbol, name, label: name, isin: null, mic: null, currency: "PLN", asset_class: "equity", region: null, sector: null,
  tags: [], valuation_mode: "market", status: "active", needs_classification: false, aliases: [], ...extra,
});

function fullState(): State {
  return {
    kind: "full",
    accounts: [
      { id: 21, name: "DIF zwykłe", broker: "dif", broker_name: "DIF", wrapper: "regular", currency: "PLN", importer: "finanse", has_mapping: false },
      { id: 22, name: "XTB IKE", broker: "xtb", broker_name: "XTB", wrapper: "ike", currency: "PLN", importer: "generic_csv", has_mapping: true },
      { id: 23, name: "XTB IKZE", broker: "xtb", broker_name: "XTB", wrapper: "ikze", currency: "PLN", importer: "generic_csv", has_mapping: true },
    ],
    instruments: [
      // P1 plans (design/v3/plan-badges): one of each kind on the held instruments, EIMI without a plan.
      inst(301, "VWRA", "Vanguard FTSE All-World", { isin: "IE00BK5BQT80", asset_class: "etf", region: "global", tags: ["global_equity"], plan: "buy", plan_at: "2026-10-01T08:00:00Z" }),
      inst(302, "SWDA", "iShares Core MSCI World", { isin: "IE00B4L5Y983", asset_class: "etf", region: "developed", tags: ["global_equity"], plan: "hold", plan_at: "2026-09-20T08:00:00Z" }),
      inst(303, "EDO0535", "Obligacje skarbowe 10-letnie EDO", { asset_class: "treasury_bond", valuation_mode: "cost", region: "pl" }),
      inst(304, "PKN", "PKN Orlen", { mic: "XWAR", region: "pl", tags: ["pl"], plan: "reduce", plan_at: "2026-10-02T08:00:00Z" }),
      inst(305, "KGH", "KGHM", { mic: "XWAR", region: "pl", tags: ["pl"], plan: "hold", plan_at: "2026-09-12T08:00:00Z" }),
      inst(306, "CDR", "CD Projekt", { mic: "XWAR", region: "pl", tags: ["pl"], plan: "buy_asap", plan_at: "2026-09-05T08:00:00Z" }),
      inst(307, "EIMI", "iShares MSCI EM IMI", { isin: "IE00BKM4GZ66", asset_class: "other", needs_classification: true }),
    ],
    holdings: [
      { inst: 301, acc: 22, qty: 120, cost: 412.3, price: 486.1, date: "2026-10-03", bucket: "global_equity" },
      { inst: 302, acc: 23, qty: 95, cost: 361.0, price: 504.38, date: "2026-10-03", bucket: "global_equity" },
      { inst: 303, acc: 21, qty: 250, cost: 100.0, price: 114.08, date: "2026-10-03", bucket: "treasury_bonds", mode: "cost" },
      { inst: 304, acc: 21, qty: 320, cost: 58.2, price: 64.5, date: "2026-10-03", bucket: "stocks" },
      { inst: 305, acc: 21, qty: 70, cost: 97.4, price: 142.3, date: "2026-10-03", bucket: "stocks" },
      { inst: 306, acc: 21, qty: 60, cost: 125.8, price: 148.6, date: "2026-10-03", bucket: "stocks" },
      { inst: 307, acc: 21, qty: 30, cost: 71.0, price: 74.57, date: "2026-10-01", bucket: null, stale: true },
    ],
    cash: [{ acc: 21, amount: 6355.3 }, { acc: 22, amount: 2410.2 }, { acc: 23, amount: 1113.5 }],
    signals: [
      sig(901, "dip_review", "drawdown_from_high", "action", 306, "CD Projekt", { name: "CD Projekt", symbol: "CDR", drawdown: 0.184, threshold: 0.15, window_days: 252, high_close: "182.10", last_close: "148.60" }, "2026-09-29"),
      sig(902, "rebalance_check", "allocation_drift", "info", null, null, { bucket_id: "stocks", bucket_generic: true, weight: 0.212, target: 0.15, drift_pp: 6.2, drift_value_base: "11600", currency: "PLN", absolute_band_pp: 5, relative_band: 0.25 }, "2026-09-15", "acknowledged"),
      sig(903, "single_stock", "position_concentration", "info", 304, "PKN Orlen", { name: "PKN Orlen", symbol: "PKN", weight: 0.111, max_weight: 0.1 }, "2026-10-02"),
      sig(904, "missed_deposit", "contribution_gap", "info", null, null, { last_deposit: "2026-08-10", day_of_month: 10, period_days: 31, grace_days: 10, monthly_amount: "2000" }, "2026-09-21"),
      // P1 plan checks: KGHM's thesis played out with no exit plan; CDR's plan buys into a weakened thesis.
      { ...sig(905, "plan:plan_no_exit", "plan:plan_no_exit", "info", 305, "KGHM", { check: "plan_no_exit", plan: "hold", health: "fulfilled", has_exit_plan: false, unrealized: 0.46, symbol: "KGH", trigger: "fulfilled" }, "2026-10-04"), message: "Teza spełniona, brak planu wyjścia" },
      { ...sig(906, "plan:plan_vs_thesis", "plan:plan_vs_thesis", "info", 306, "CD Projekt", { check: "plan_vs_thesis", plan: "buy_asap", health: "weakened", has_exit_plan: true, unrealized: 0.18, symbol: "CDR" }, "2026-10-04"), message: "Rekomendacja: dokup asap, teza osłabiona" },
    ],
    decisions: [],
    theses: [{
      id: 41, instrument_id: 306, entry_type: "sentiment_correction",
      thesis: "wartość (P/E poniżej mediany 5 lat, pipeline gier 2027).", invalidation: "utrata udziału w rynku przez 2 lata z rzędu lub zmiana zarządu.",
      exit_plan: "+60 % od kosztu albo koniec 2028, co pierwsze.", size_plan: "do ok. 6 % portfela, dokupienia przy spadkach.",
      reviewed_at: "2026-09-27T10:00:00+02:00", created_at: "2025-03-12T18:00:00+01:00", updated_at: "2026-09-27T10:00:00+02:00",
    }, {
      // P1: KGHM's thesis played out (fulfilled) and has no exit plan (the plan check `brak planu wyjścia`).
      id: 42, instrument_id: 305, entry_type: "trend",
      thesis: "trend: deficyt podaży miedzi, marża segmentu wraca powyżej średniej 5 lat.", invalidation: "nadwyżka podaży dwa kwartały z rzędu.",
      exit_plan: null, size_plan: "do ok. 6 % portfela.",
      reviewed_at: "2026-09-27T10:00:00+02:00", created_at: "2025-06-02T18:00:00+02:00", updated_at: "2026-09-12T10:00:00+02:00",
    }],
    reviews: [{ id: 1, module: "investments", done_at: "2026-09-27T11:41:00+02:00", notes: "Bez zmian w strategii.", stats: { minutes: 41 } }],
    proposals: [{
      id: 71, kind: "custom_rule", status: "pending", summary: "Rule turnover (custom): fired 2x in backtest",
      summary_code: "custom_rule", summary_params: { rule_id: "turnover", rule_kind: "custom", episodes: 2, evaluated: 104 }, reason: "Ograniczenie nadmiernego handlu po rozmowie o strategii.",
      created_at: "2026-10-03T20:14:00+02:00",
      diff: { yaml: "  rules:\n    - id: dip_review\n      kind: drawdown_from_high\n      params: { threshold: 0.15 }\n+   - id: turnover\n+     kind: custom\n+     params:\n+       scope: portfolio\n+       when: 'trades_30d > 4'\n+       message: Więcej niż 4 transakcje w 30 dni" },
      backtest: { evaluated: 104, step_days: 7, from: "2024-10-07", to: "2026-10-04", points_fired: 3, episodes: 2, first_fired: "2025-03-17", last_fired: "2026-01-12", instruments: [] },
    }],
    strategyVersion: 7,
    imports: [
      { id: 61, account_id: 21, importer: "finanse", broker: "dif", file_name: "dif_2026-10-01.csv", inserted: 6, duplicates: 3, new_instruments: 1, corrections: 0, warnings: 0, created_at: "2026-10-01T19:02:00+02:00" },
    ],
    manual: [],
    nextId: 1000,
  };
}

function emptyState(): State {
  return {
    kind: "empty",
    accounts: [{ id: 121, name: "XTB IKE", broker: "xtb", broker_name: "XTB", wrapper: "ike", currency: "PLN", importer: null, has_mapping: false }],
    instruments: [], holdings: [], cash: [], signals: [], decisions: [], theses: [], reviews: [], proposals: [],
    strategyVersion: null, imports: [], manual: [], nextId: 5000,
  };
}

function sig(id: number, rule: string, kind: string, severity: string, instrumentId: number | null, label: string | null,
  payload: Record<string, unknown>, since: string, status = "active"): Signal {
  return {
    id, rule_id: rule, kind, dedup_key: `${rule}|${instrumentId ?? ""}`, severity, status, message: `${kind} fired`,
    instrument_id: instrumentId, instrument_label: label, account_id: null, payload,
    first_seen_at: `${since}T07:02:00+02:00`, last_seen_at: `${TODAY}T07:02:00+02:00`,
    acknowledged_at: status === "acknowledged" ? `${since}T20:00:00+02:00` : null, closed_at: null, decisions: [],
  };
}

const states = new Map<string, State>();
function stateOf(slug: string, kind: Kind): State {
  let st = states.get(slug);
  if (!st) { st = kind === "full" ? fullState() : emptyState(); states.set(slug, st); }
  return st;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const TARGETS: Record<string, number> = { global_equity: 0.6, stocks: 0.15, treasury_bonds: 0.2, cash: 0.05 };

function valued(st: State, filter: number[] | null) {
  const inScope = (acc: number) => !filter || filter.includes(acc);
  const hs = st.holdings.filter((h) => inScope(h.acc));
  const cash = st.cash.filter((c) => inScope(c.acc));
  const cashTotal = r2(cash.reduce((a, c) => a + c.amount, 0));
  const holdTotal = r2(hs.reduce((a, h) => a + h.qty * h.price, 0));
  return { hs, cash, cashTotal, holdTotal, total: r2(cashTotal + holdTotal) };
}

function allocation(st: State, filter: number[] | null) {
  const v = valued(st, filter);
  const hasStrategy = st.strategyVersion != null;
  const by: Record<string, number> = {};
  for (const h of v.hs) if (h.bucket) by[h.bucket] = (by[h.bucket] ?? 0) + h.qty * h.price;
  by.cash = v.cashTotal;
  const unclassifiedValue = v.hs.filter((h) => !h.bucket).reduce((a, h) => a + h.qty * h.price, 0);
  const band = { absolute_band_pp: 5, relative_band: 0.25, min_trade_value: 500 };
  const buckets = hasStrategy ? Object.entries(TARGETS).map(([id, target]) => {
    const value = r2(by[id] ?? 0);
    const weight = v.total ? value / v.total : 0;
    const drift = (weight - target) * 100;
    const half = Math.min(band.absolute_band_pp / 100, band.relative_band * target);
    const out = Math.abs(weight - target) > half + 1e-9 && Math.abs(value - target * v.total) >= band.min_trade_value;
    return { bucket_id: id, generic: true, weight: Math.round(weight * 1e6) / 1e6, target, drift_pp: Math.round(drift * 1e4) / 1e4, value, to_target: r2(target * v.total - value), out_of_band: out, band_note: null, cash_history_gap: false, instrument_ids: v.hs.filter((h) => h.bucket === id).map((h) => h.inst) };
  }) : [];
  const shares = (key: (h: State["holdings"][number]) => string) => {
    const m: Record<string, number> = {};
    for (const h of v.hs) m[key(h)] = (m[key(h)] ?? 0) + h.qty * h.price;
    if (v.cashTotal) m.cash = (m.cash ?? 0) + v.cashTotal;
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, val]) => ({ key: k, value: r2(val), weight: v.total ? val / v.total : null }));
  };
  const instOf = (id: number) => st.instruments.find((i) => i.id === id)!;
  return {
    base_currency: "PLN", total: v.total, has_strategy: hasStrategy, buckets, buckets_generic: buckets.length > 0,
    unclassified: hasStrategy ? { value: r2(unclassifiedValue), weight: v.total ? unclassifiedValue / v.total : null, instruments: v.hs.filter((h) => !h.bucket).map((h) => ({ id: h.inst, label: instOf(h.inst).label })) } : null,
    unallocated_cash: hasStrategy ? 0 : null,
    by_asset_class: shares((h) => instOf(h.inst).asset_class),
    by_region: shares((h) => instOf(h.inst).region ?? "unknown"),
    band: hasStrategy ? band : null,
  };
}

function overview(st: State, filter: number[] | null): Overview {
  const v = valued(st, filter);
  const alloc = allocation(st, filter);
  const cost = v.hs.reduce((a, h) => a + h.qty * h.cost, 0);
  const open = st.signals.filter((s) => s.status === "active" || s.status === "acknowledged");
  const maxDrift = alloc.buckets.reduce<typeof alloc.buckets[number] | null>((m, b) => (!m || Math.abs(b.drift_pp) > Math.abs(m.drift_pp) ? b : m), null);
  const stale = v.hs.filter((h) => h.stale).map((h) => ({ instrument_id: h.inst, label: st.instruments.find((i) => i.id === h.inst)!.label, price_date: h.date, account_id: h.acc }));
  return {
    as_of: TODAY, base_currency: "PLN", accounts_filter: filter,
    kpis: {
      value: { total: v.total, holdings: v.holdTotal, cash: v.cashTotal },
      unrealized: { amount: cost ? r2(v.holdTotal - cost) : null, pct: cost ? (v.holdTotal - cost) / cost : null, cost: cost ? r2(cost) : null },
      cash: { amount: v.cashTotal, weight: v.total ? v.cashTotal / v.total : null, accounts: v.cash.filter((c) => c.amount).length },
      signals: { action: open.filter((s) => s.severity === "action").length, info: open.filter((s) => s.severity !== "action").length, new: open.filter((s) => s.status === "active").length },
      max_drift: maxDrift ? { bucket_id: maxDrift.bucket_id, drift_pp: maxDrift.drift_pp, out_of_band: maxDrift.out_of_band } : null,
      out_of_band: alloc.buckets.filter((b) => b.out_of_band).length,
      last_run: st.kind === "full" ? { id: 88, trigger: "worker", as_of: TODAY, status: "partial", started_at: `${TODAY}T07:01:40+02:00`, finished_at: `${TODAY}T07:02:10+02:00`, errors: ["stooq: 1 źródło cen nie odpowiedziało"], stats: {}, new_signal_ids: [903], escalated_signal_ids: [] } : null,
      realized: st.kind === "full" ? 1820.4 : null,
    },
    allocation: alloc,
    freshness: {
      prices: { newest_bar: st.kind === "full" ? "2026-10-03" : null, stale, stale_count: stale.length + (st.kind === "full" ? 1 : 0), stale_weight: 0.012 },
      fx: { newest_rate: st.kind === "full" ? "2026-10-03" : null, missing: [] },
      strategy: { state: st.strategyVersion ? "partial" : "missing", version: st.strategyVersion, changed: false, errors: 0, warnings: st.strategyVersion ? 1 : 0, inactive_rules: st.strategyVersion ? 1 : 0 },
    },
    warnings: st.kind === "full" ? [{ kind: "stale_fx_rate", message: "Stale USD/PLN FX rate for 2026-10-03: newest rate 2026-10-02 is 1 days old", account_id: null, instrument_id: null }] : [],
    accounts: accounts(st, filter),
  };
}

function accounts(st: State, filter: number[] | null): AccountRow[] {
  const v = valued(st, null);
  const snap: Record<number, string> = { 21: "2026-10-01", 22: "2026-09-15", 23: "2026-09-30" };
  return st.accounts.map((a) => {
    const value = st.holdings.filter((h) => h.acc === a.id).reduce((s, h) => s + h.qty * h.price, 0) + (st.cash.find((c) => c.acc === a.id)?.amount ?? 0);
    const inScope = !filter || filter.includes(a.id);
    return {
      ...a, value: inScope && st.kind === "full" ? r2(value) : st.kind === "full" ? null : 0, share: inScope && v.total ? value / v.total : null,
      snapshot_date: snap[a.id] ?? null,
      last_import: st.imports.filter((b) => b.account_id === a.id).map((b) => ({ batch_id: b.id, at: b.created_at, file_name: b.file_name }))[0] ?? (st.kind === "full" ? { batch_id: 1, at: "2026-09-15T10:00:00+02:00", file_name: "xtb.csv" } : null),
    };
  });
}

function positions(st: State, filter: number[] | null): Positions {
  const v = valued(st, filter);
  const rows: Position[] = v.hs.map((h) => {
    const i = st.instruments.find((x) => x.id === h.inst)!;
    const value = r2(h.qty * h.price), cost = r2(h.qty * h.cost);
    const acc = st.accounts.find((a) => a.id === h.acc)!;
    const lots = h.inst === 306
      ? [{ account_id: h.acc, open_date: "2025-03-12", quantity: 40, unit_cost: 118.2, currency: "PLN", open_txn_id: 1, result: r2(40 * (h.price - 118.2)) },
        { account_id: h.acc, open_date: "2025-07-21", quantity: 20, unit_cost: 141.0, currency: "PLN", open_txn_id: 2, result: r2(20 * (h.price - 141)) }]
      : [{ account_id: h.acc, open_date: "2025-01-15", quantity: h.qty, unit_cost: h.cost, currency: "PLN", open_txn_id: 3, result: r2(h.qty * (h.price - h.cost)) }];
    return {
      instrument: i, bucket: h.bucket, quantity: h.qty, price: h.price, price_date: h.date, price_currency: "PLN", is_stale: !!h.stale,
      valuation_mode: h.mode ?? "market", missing_fx_currency: null, value, cost, unrealized: r2(value - cost), unrealized_pct: (value - cost) / cost,
      weight: value / v.total, realized: null, dividends: h.inst === 304 ? { PLN: 1344 } : ({} as Record<string, number>),
      accounts: [{ account_id: h.acc, account_name: acc.name, quantity: h.qty, average_cost: h.cost, cost_currency: "PLN", value, cost, unrealized_pct: (value - cost) / cost, weight: value / v.total }],
      lots, open_signals: st.signals.filter((s) => s.instrument_id === h.inst && (s.status === "active" || s.status === "acknowledged")).length,
      has_thesis: st.theses.some((t) => t.instrument_id === h.inst),
    };
  }).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return {
    as_of: TODAY, base_currency: "PLN", positions: rows, total: v.total,
    cash: v.cash.map((c) => ({ account_id: c.acc, account_name: st.accounts.find((a) => a.id === c.acc)!.name, currency: "PLN", amount: c.amount, amount_base: c.amount })),
  };
}

function series(h: State["holdings"][number]): { date: string; close: number }[] {
  // 24 months of weekly closes: a deterministic wave ending at the current price.
  const out: { date: string; close: number }[] = [];
  const end = new Date(2026, 9, 3);
  const n = 104;
  for (let k = n; k >= 0; k--) {
    const t = new Date(end.getTime() - k * 7 * 86400000);
    const x = (n - k) / n;
    const shape = h.inst === 306 ? 0.82 + 0.42 * Math.sin(x * 3.1) + 0.06 * Math.sin(x * 23) : 0.78 + 0.22 * x + 0.04 * Math.sin(x * 17);
    out.push({ date: `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`, close: r2(h.price * shape / (h.inst === 306 ? 0.82 + 0.42 * Math.sin(3.1) + 0.06 * Math.sin(23) : 1.0 + 0.04 * Math.sin(17))) });
  }
  return out;
}

function chart(st: State, id: number): PositionChart {
  const h = st.holdings.find((x) => x.inst === id);
  if (!h) throw new ApiError(404, `No instrument ${id} in this profile`);
  const i = st.instruments.find((x) => x.id === id)!;
  const sr = h.mode === "cost" ? [] : series(h);
  const high = sr.length ? Math.max(...sr.slice(-52).map((p) => p.close)) : null;
  const thresholds = [];
  if (high != null && i.asset_class === "equity") thresholds.push({ rule_id: "dip_review", kind: "drawdown_from_high", threshold: 0.15, basis: "high", window_days: 252, y: r2(high * 0.85) });
  if (i.asset_class === "equity") thresholds.push({ rule_id: "take_profit", kind: "gain_from_cost", threshold: 0.5, basis: "cost", window_days: null, y: r2(h.cost * 1.5) });
  return {
    instrument_id: id, label: i.label, currency: "PLN", valuation_mode: h.mode ?? "market", as_of: TODAY, series: sr, high_52w: high,
    last: sr[sr.length - 1] ?? null, cost: { average: h.cost, currency: "PLN" }, thresholds,
    markers: id === 306 ? [{ date: "2025-03-12", type: "buy", quantity: 40, price: 118.2, currency: "PLN", account_id: 21 }, { date: "2025-07-21", type: "buy", quantity: 20, price: 141, currency: "PLN", account_id: 21 }] : [{ date: "2025-01-15", type: "buy", quantity: h.qty, price: h.cost, currency: "PLN", account_id: h.acc }],
  };
}

function detail(st: State, id: number): PositionDetail {
  const c = chart(st, id);
  const pos = positions(st, null).positions.find((p) => p.instrument.id === id) ?? null;
  return {
    instrument: st.instruments.find((x) => x.id === id) ?? null, position: pos, series: c.series, high_52w: c.high_52w,
    transactions: c.markers.map((m, k) => ({ id: k + 1, account_id: m.account_id ?? 21, account_name: null, type: m.type, trade_date: m.date, instrument_id: id, quantity: m.quantity, price: m.price, currency: "PLN", gross_amount: (m.quantity ?? 0) * (m.price ?? 0), fee: 0, tax: 0, cash_amount: -((m.quantity ?? 0) * (m.price ?? 0)), cash_currency: "PLN", fx_rate: null, split_ratio: null, source: "import", note: null, external_ref: null })),
    theses: st.theses.filter((t) => t.instrument_id === id),
    decisions: st.decisions.filter((d) => d.instrument_id === id),
    manual_valuations: [],
  };
}

function strategy(st: State): StrategyStatus {
  const v = st.strategyVersion;
  if (v == null) {
    return {
      state: "missing", version: null, changed: false, errors: 0, warnings: 0,
      files: { yaml: "~/Library/Application Support/finanse/profiles/marta/strategy.yaml", md: "~/Library/Application Support/finanse/profiles/marta/strategy.md", yaml_exists: false, md_exists: false },
      read_error: null, issues: [], inactive_rules: [], facts: null, base_currency_note: null, versions: [],
    };
  }
  return {
    state: "partial", version: v, changed: false, errors: 0, warnings: 1,
    files: { yaml: "~/Library/Application Support/finanse/profiles/jan/strategy.yaml", md: "~/Library/Application Support/finanse/profiles/jan/strategy.md", yaml_exists: true, md_exists: true },
    read_error: null,
    // issues as the real loader reports them (code + params, F7 D1): a typo warning and a rule left inactive
    issues: [{ severity: "warning", path: "rules[1].cooldown_dyas", message: 'Unknown key "cooldown_dyas" (did you mean "cooldown_days"?); it is ignored', line: 24, column: 5, code: "strategy.unknown_key", params: { key: "cooldown_dyas", suggestion: "cooldown_days" } }],
    inactive_rules: [{ index: 4, rule_id: "cash_floor", kind: "cash_level", line: 41, issues: [{ severity: "error", path: "rules[4].params", message: "cash_level needs min_weight, max_weight or both", line: 43, column: 13, code: "strategy.cash_level_needs_bound", params: {} }] }],
    facts: {
      base_currency: "PLN", buckets: Object.keys(TARGETS), targets: TARGETS,
      rules: [
        { id: "rebalance_check", kind: "allocation_drift", severity: "action", cooldown_days: 14 },
        { id: "single_stock", kind: "position_concentration", severity: "info", cooldown_days: null },
        { id: "dip_review", kind: "drawdown_from_high", severity: "action", cooldown_days: 30 },
        { id: "take_profit", kind: "gain_from_cost", severity: "info", cooldown_days: null },
        { id: "missed_deposit", kind: "contribution_gap", severity: "info", cooldown_days: null },
      ],
      horizon_years: 10, contributions: { monthly_amount: 2000, day_of_month: 10 },
      notifications: { immediate: ["action"], digest_weekday: "sunday" },
      bucket_matches: [
        { id: "global_equity", asset_class: ["etf"], tags: ["global_equity"], mic: [], currency: [], instrument_ids: [] },
        { id: "stocks", asset_class: ["equity"], tags: ["pl"], mic: [], currency: [], instrument_ids: [] },
        { id: "treasury_bonds", asset_class: ["bond", "treasury_bond"], tags: [], mic: [], currency: [], instrument_ids: [] },
        { id: "cash", asset_class: ["cash"], tags: [], mic: [], currency: [], instrument_ids: [] },
      ],
    },
    base_currency_note: null,
    versions: Array.from({ length: v }, (_, k) => ({ version: v - k, state: k === 0 ? "partial" : "valid", created_at: k === 0 ? "2026-10-02T21:00:00+02:00" : `2026-0${Math.max(1, 9 - k)}-01T10:00:00+02:00`, sha256: "0".repeat(64), issues: k === 0 ? 2 : 0 })),
  };
}

function digest(st: State): ReviewDigest {
  const last = st.reviews[0] ?? null;
  const since = last ? last.done_at : "2026-09-27T09:12:00+02:00";
  const open = st.signals.filter((s) => s.status === "active" || s.status === "acknowledged");
  const full = st.kind === "full";
  const lastDay = last ? last.done_at.slice(0, 10) : null;
  return {
    as_of: TODAY, since: since.slice(0, 10), since_at: since, until_at: NOW, baseline: last ? "review" : "default_7d",
    last_review: last ? { done_at: last.done_at, notes: last.notes, stats: last.stats ?? {} } : null,
    digest_weekday: "sunday", review_due: lastDay == null || lastDay < TODAY,
    value: full ? { currency: "PLN", then: 183161.05, now: overview(st, null).kpis.value.total, change: r2(overview(st, null).kpis.value.total - 183161.05), change_pct: (overview(st, null).kpis.value.total - 183161.05) / 183161.05 } : { currency: "PLN", then: null, now: 0, change: null, change_pct: null },
    signals: {
      new: st.signals.filter((s) => s.first_seen_at && s.first_seen_at > since),
      escalated: [],
      resolved: full ? [{ ...sig(899, "take_profit", "gain_from_cost", "info", 305, "KGHM", { name: "KGHM", symbol: "KGH", unrealized_pct: 0.461, threshold: 0.5 }, "2026-09-02", "expired"), closed_at: "2026-10-01T07:02:00+02:00" }] : [],
      open: open.length, undecided: open.filter((s) => !s.decisions.length).length,
    },
    imports: st.imports.filter((b) => b.created_at > since).map((b) => ({ ...b, account_name: st.accounts.find((a) => a.id === b.account_id)?.name ?? null })),
    transactions: full ? { count: 6 + st.manual.length, by_type: { buy: 2, dividend: 1, fee: 3 }, manual: st.manual.length } : { count: st.manual.length, by_type: {}, manual: st.manual.length },
    decisions: st.decisions.filter((d) => (d.created_at ?? "") > since),
    dividends: full ? { PLN: 1344 } : {},
    price_moves: full ? [{ instrument_id: 306, label: "CD Projekt", from_date: "2026-09-26", from: 163.2, to_date: "2026-10-03", to: 148.6, change_pct: -0.0895 }] : [],
    warnings: [], stale_count: full ? 2 : 0,
    strategy: { version: st.strategyVersion, state: st.strategyVersion ? "partial" : "missing", changed_since: false },
  };
}

function preview(st: State, accountId: number, fileName: string): ImportPreview {
  const acc = st.accounts.find((a) => a.id === accountId);
  if (!acc) throw new ApiError(404, `No brokerage account ${accountId} in this profile`);
  const full = st.kind === "full";
  const row = (r: number, date: string, type: string, label: string | null, q: number | null, amount: number, status = "new", isNew = false) => ({
    row: r, date, type, instrument: label ? { id: isNew ? "new-1" : r, label, new: isNew } : null, quantity: q, price: null, currency: "PLN", amount, cash_currency: "PLN", status,
  });
  const rows = full ? [
    row(0, "2026-10-01", "buy", "EIMI", 30, -2130, "new", true), row(1, "2026-10-01", "buy", "KGHM", 10, -1423), row(2, "2026-10-01", "dividend", "PKN Orlen", null, 1344),
    row(3, "2026-10-01", "tax", "PKN Orlen", null, -255.36), row(4, "2026-09-30", "fee", null, null, -9.9), row(5, "2026-09-12", "buy", "VWRA", 10, -4790, "duplicate"),
    row(6, "2026-09-12", "deposit", null, null, 2000, "duplicate"), row(7, "2026-09-02", "fee", null, null, -9.9, "duplicate"),
    ...Array.from({ length: 11 }, (_, k) => row(8 + k, `2026-09-${String(28 - k * 2).padStart(2, "0")}`, k % 3 ? "fee" : "interest", null, null, k % 3 ? -4.5 : 12.3)),
  ] : [
    row(0, "2026-10-02", "deposit", null, null, 3000), row(1, "2026-10-03", "buy", "VWCE", 6, -2861.4, "new", true),
  ];
  const newRows = rows.filter((r) => r.status === "new").length;
  return {
    file_id: "f".repeat(64), file_name: fileName, size: 4210,
    account: { id: acc.id, name: acc.name, broker: acc.broker, broker_name: acc.broker_name },
    importer: { id: acc.importer ?? "finanse", name: acc.importer === "generic_csv" ? "CSV z mapowaniem" : "format finanse", detected: [acc.importer ?? "finanse"], requested: "auto" },
    can_commit: true,
    warnings: full ? [{ message: "Row 18: unknown type CORP ACT skipped", row: 18, kind: "skipped", blocking: false }] : [],
    errors: [], previous_imports: [], account_hint: null,
    counts: { rows: rows.length + (full ? 1 : 0), new: newRows, duplicates: rows.length - newRows, positions: full ? 6 : 0, renames: 0, status_changes: 0, new_instruments: 1, warnings: full ? 1 : 0, errors: 0 },
    rows, new_instruments: [inst(-1, full ? "EIMI" : "VWCE", full ? "iShares MSCI EM IMI" : "Vanguard FTSE All-World (Acc)", { needs_classification: true })],
    renames: [], status_changes: [],
    reconciliation: full ? {
      account_id: acc.id, as_of: "2026-10-01", mismatches: 1, warnings: [],
      diffs: [
        { instrument_id: 301, label: "VWRA", broker_quantity: 80, computed_quantity: 80, delta: 0, kind: "match", currency: "PLN", correction: null },
        { instrument_id: 306, label: "CDR", broker_quantity: 60, computed_quantity: 58, delta: 2, kind: "missing_units", currency: "PLN", correction: { type: "adjustment", quantity: 2, price: null, date: "2024-02-01", note: "luka przed 2024-02" } },
        { instrument_id: 304, label: "PKN Orlen", broker_quantity: 320, computed_quantity: 320, delta: 0, kind: "match", currency: "PLN", correction: null },
        { instrument_id: 305, label: "KGHM", broker_quantity: 70, computed_quantity: 70, delta: 0, kind: "match", currency: "PLN", correction: null },
        { instrument_id: "new-1", label: "EIMI", broker_quantity: 30, computed_quantity: 30, delta: 0, kind: "match", currency: "PLN", correction: null },
      ],
    } : null,
  };
}

const today = () => TODAY;

/** Router of the investments mock: `path` is the part after /api/p/{slug}. */
export function investmentsMock(slug: string, kind: Kind, path: string, q: URLSearchParams, method: string, body: unknown): unknown {
  const st = stateOf(slug, kind);
  const filter = q.get("accounts") ? q.get("accounts")!.split(",").map(Number) : null;
  const b = (body ?? {}) as Record<string, unknown>;
  const m = (re: RegExp) => re.exec(path);
  if (path === "/reviews" && method === "GET") return st.reviews;
  if (path === "/reviews" && method === "POST") {
    const rv: Review = { id: st.nextId++, module: "investments", done_at: new Date().toISOString(), notes: (b.notes as string) ?? null, stats: (b.stats as Record<string, unknown>) ?? {} };
    st.reviews.unshift(rv);
    return rv;
  }
  if (path === "/proposals") return st.proposals.filter((p) => !q.get("status") || p.status === q.get("status"));
  let mm = m(/^\/proposals\/(\d+)(?:\/(approve|reject))?$/);
  if (mm) {
    const p = st.proposals.find((x) => x.id === Number(mm![1]));
    if (!p) throw new ApiError(404, "No proposal");
    if (mm[2] === "approve") { p.status = "approved"; p.reviewed_at = new Date().toISOString(); st.strategyVersion = (st.strategyVersion ?? 0) + 1; p.result = { version: st.strategyVersion, state: "valid" }; return p; }
    if (mm[2] === "reject") { p.status = "rejected"; p.reviewed_at = new Date().toISOString(); return p; }
    return p;
  }
  if (!path.startsWith("/investments")) throw new ApiError(404, `mock: brak ${method} ${path}`);
  const ip = path.slice("/investments".length);
  switch (ip) {
    case "/overview": return overview(st, filter);
    case "/positions": return positions(st, filter);
    case "/accounts":
      if (method === "POST") {
        const acc: AccountRow = { id: st.nextId++, name: String(b.name), broker: String(b.broker), broker_name: String(b.broker).toUpperCase(), wrapper: String(b.wrapper), currency: String(b.currency), importer: null, has_mapping: false };
        st.accounts.push(acc);
        return acc;
      }
      return accounts(st, null);
    case "/signals": {
      const status = q.get("status") ?? "open";
      const open = (s: Signal) => s.status === "active" || s.status === "acknowledged";
      return st.signals.filter((s) => (status === "all" ? true : status === "open" ? open(s) : !open(s)))
        .map((s) => ({ ...s, decisions: st.decisions.filter((d) => d.signal_id === s.id) }));
    }
    case "/decisions": return st.decisions;
    case "/instruments": return st.instruments.filter((i) => q.get("unclassified") !== "true" || i.needs_classification);
    case "/strategy": return strategy(st);
    case "/strategy/init":
      if (st.strategyVersion != null) throw new ApiError(409, "strategy files exist");
      st.strategyVersion = 1;
      return { written: ["strategy.yaml", "strategy.md"], status: strategy(st) };
    case "/strategy/reload": return strategy(st);
    case "/review-digest": return digest(st);
    case "/imports": return st.imports;
    case "/runs": return [];
    case "/transactions":
      if (method === "POST") {
        const t: Txn = {
          id: st.nextId++, account_id: Number(b.account_id), account_name: null, type: String(b.type), trade_date: String(b.trade_date),
          instrument_id: (b.instrument_id as number) ?? null, quantity: (b.quantity as number) ?? null, price: (b.price as number) ?? null, currency: "PLN",
          gross_amount: Number(b.gross_amount ?? 0), fee: Number(b.fee ?? 0), tax: 0, cash_amount: 0, cash_currency: "PLN", fx_rate: null, split_ratio: null, source: "manual", note: (b.note as string) ?? null, external_ref: null,
        };
        st.manual.push(t);
        if (st.kind === "empty" && t.type === "deposit") st.cash = [{ acc: t.account_id, amount: (st.cash[0]?.amount ?? 0) + t.gross_amount }];
        return { transaction: t, instrument: null, new_instrument: !b.instrument_id && !!b.instrument, warnings: [] };
      }
      return st.manual;
    case "/run":
      return { trigger: "api", as_of: today(), offline: false, profiles: [{ profile: slug, status: st.strategyVersion ? "partial" : "ok", errors: [], new_signals: [], escalated_signals: [] }], market_errors: [] };
    case "/import/preview": {
      const fd = body as FormData;
      const file = fd?.get?.("file") as File | null;
      return preview(st, Number(fd?.get?.("account_id")), file?.name ?? "import.csv");
    }
    case "/import/commit": {
      const pv = preview(st, Number(b.account_id), String(b.file_name));
      const batch: Batch = { id: st.nextId++, account_id: Number(b.account_id), importer: pv.importer.id ?? "finanse", broker: pv.account.broker, file_name: String(b.file_name), inserted: pv.counts!.new, duplicates: pv.counts!.duplicates, new_instruments: 1, corrections: (b.corrections as unknown[]).length, warnings: 0, created_at: new Date().toISOString() };
      st.imports.unshift(batch);
      return { batch_id: batch.id, inserted: batch.inserted, duplicates: batch.duplicates, new_instrument_ids: [st.nextId++], positions: pv.counts!.positions, renames: 0, status_changes: 0, corrections: batch.corrections, archive_path: "imports/…" };
    }
  }
  mm = m(/^\/investments\/positions\/(\d+)\/chart$/);
  if (mm) return chart(st, Number(mm[1]));
  mm = m(/^\/investments\/positions\/(\d+)$/);
  if (mm) return detail(st, Number(mm[1]));
  mm = m(/^\/investments\/signals\/(\d+)\/(decision|acknowledge)$/);
  if (mm) {
    const s = st.signals.find((x) => x.id === Number(mm![1]));
    if (!s) throw new ApiError(404, "No signal");
    const d: Decision = {
      id: st.nextId++, signal_id: s.id, instrument_id: s.instrument_id, account_id: (b.account_id as number) ?? null,
      action: mm[2] === "acknowledge" ? "held" : String(b.action), quantity: (b.quantity as number) ?? null, price: (b.price as number) ?? null,
      currency: (b.currency as string) ?? null, reason: (b.reason as string) ?? null, created_at: new Date().toISOString(),
    };
    st.decisions.push(d);
    s.status = "acknowledged";
    s.acknowledged_at = d.created_at;
    return { decision: d, signal: { ...s, decisions: st.decisions.filter((x) => x.signal_id === s.id) } };
  }
  mm = m(/^\/investments\/instruments\/(\d+)$/);
  if (mm && method === "PATCH") {
    const i = st.instruments.find((x) => x.id === Number(mm![1]));
    if (!i) throw new ApiError(404, "No instrument");
    Object.assign(i, Object.fromEntries(Object.entries(b).filter(([, v]) => v != null)), { needs_classification: false });
    const h = st.holdings.find((x) => x.inst === i.id);
    if (h) h.bucket = i.asset_class === "etf" && i.tags.includes("global_equity") ? "global_equity" : i.asset_class === "equity" && i.tags.includes("pl") ? "stocks" : null;
    return i;
  }
  mm = m(/^\/investments\/instruments\/(\d+)\/plan$/);
  if (mm && method === "PUT") {
    const i = st.instruments.find((x) => x.id === Number(mm![1]));
    if (!i) throw new ApiError(404, "No instrument", "not_found");
    const plan = (b.plan as string | null) ?? null;
    const held = st.holdings.some((h) => h.inst === i.id);
    if (plan != null && (!["buy_asap", "buy", "hold", "reduce", "exit_asap"].includes(plan) || (!held && (plan === "reduce" || plan === "exit_asap")))) {
      throw new ApiError(422, `invalid plan: ${plan}`, "invalid_plan");
    }
    Object.assign(i, { plan, plan_at: plan ? new Date().toISOString() : null });
    return { instrument: i };
  }
  mm = m(/^\/investments\/instruments\/(\d+)\/theses$/);
  if (mm && method === "POST") {
    const t: Thesis = { id: st.nextId++, instrument_id: Number(mm[1]), entry_type: (b.entry_type as string) ?? null, thesis: (b.thesis as string) ?? null, invalidation: (b.invalidation as string) ?? null, exit_plan: (b.exit_plan as string) ?? null, size_plan: (b.size_plan as string) ?? null, reviewed_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    st.theses.push(t);
    return t;
  }
  mm = m(/^\/investments\/theses\/(\d+)$/);
  if (mm && method === "PATCH") {
    const t = st.theses.find((x) => x.id === Number(mm![1]));
    if (!t) throw new ApiError(404, "No thesis");
    Object.assign(t, b, { updated_at: new Date().toISOString(), ...(b.reviewed ? { reviewed_at: new Date().toISOString() } : {}) });
    return t;
  }
  throw new ApiError(404, `mock: brak ${method} ${path}`);
}

/** MCP audit log (track M contract: argument names and JSON types only, never values). */
export function mcpCallsMock(kind: Kind) {
  if (kind !== "full") return [];
  return [
    { id: 4, tool: "propose_custom_rule", privacy: "strict", called_at: "2026-10-03T18:14:00Z", args: { kind_or_expression: "string", params: "object", reason: "string" }, outcome: "ok", error_kind: null, duration_ms: 412 },
    { id: 3, tool: "get_signals", privacy: "strict", called_at: "2026-10-03T18:11:00Z", args: { status: "string" }, outcome: "ok", error_kind: null, duration_ms: 38 },
    { id: 2, tool: "get_transactions", privacy: "strict", called_at: "2026-10-03T18:10:30Z", args: { account: "string" }, outcome: "refused", error_kind: "module_disabled", duration_ms: 3 },
    { id: 1, tool: "get_portfolio", privacy: "strict", called_at: "2026-10-03T18:10:00Z", args: {}, outcome: "ok", error_kind: null, duration_ms: 95 },
  ];
}
