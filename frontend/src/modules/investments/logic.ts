// Workspace logic without React: signal and warning copy, the weekly-review change list, the
// decision effect line, allocation bands and scale, manual transaction rules. Unit-tested with
// `npm test` (node --test strips the types; imports carry their .ts extension for that).
import {
  accountLabel, type AccountLike, assetClass, bucketLabel, DECISION_ACTION, dm, money, money0, nInstruments, nTxns, pct,
  pctTarget, pp, qty, txnType, WEEKDAY_INDEX,
} from "./labels.ts";
import { S } from "./logic.strings.ts";

// Structural types (a subset of api.ts) keep this module free of the transport.
export interface SignalLike {
  id: number;
  rule_id: string;
  kind: string;
  severity: string;
  status: string;
  message: string;
  instrument_label: string | null;
  payload: Record<string, unknown>;
  first_seen_at: string | null;
  decisions: { action: string; quantity: number | null; created_at: string | null }[];
}
export interface BucketLike { bucket_id: string; weight: number | null; target: number; drift_pp: number; value: number; to_target: number; out_of_band: boolean | null }
export interface BandPolicy { absolute_band_pp: number; relative_band: number; min_trade_value: number }

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Severity dot / tag of a signal: action (red), review (amber), resolved (grey). */
export function signalTone(sig: Pick<SignalLike, "severity" | "status">): "action" | "review" | "resolved" {
  if (sig.status === "resolved" || sig.status === "expired") return "resolved";
  return sig.severity === "action" ? "action" : "review";
}

/** Label of the instrument a signal is about: "CD Projekt (CDR)". */
export function signalInstrument(sig: SignalLike): string | null {
  const name = s(sig.payload.name) ?? sig.instrument_label;
  const sym = s(sig.payload.symbol);
  if (!name) return sym;
  return sym && sym !== name ? `${name} (${sym})` : name;
}

/** Title of a signal by rule kind (copy deck "Signals"). Custom rules keep their message. */
export function signalTitle(sig: SignalLike): string {
  const p = sig.payload;
  const inst = s(p.name) ?? sig.instrument_label ?? s(p.symbol) ?? "";
  switch (sig.kind) {
    case "drawdown_from_high": return S.titleDrawdown(pctTarget(n(p.threshold)));
    case "allocation_drift": { const b = bucketLabel(s(p.bucket_id)); return b ? S.titleDrift(b) : S.titleDriftPlain; }
    case "position_concentration": return S.titleConcentration(inst);
    case "contribution_gap": return S.titleContributionGap;
    case "loss_from_cost": return S.titleLoss(pctTarget(n(p.threshold)));
    case "gain_from_cost": return S.titleGain(pctTarget(n(p.threshold)));
    case "cash_level": return p.direction === "above_max" ? S.titleCashHigh : S.titleCashLow;
    case "tagged_weight": return S.titleTagged(Array.isArray(p.tags) ? p.tags.join(", ") : "");
    default: return sig.message || S.titleCustom; // never the strategy's rule id (FE-A A6)
  }
}

/** Facts of a signal: "zmierzono -18,4 % · próg 15 %" plus extras (copy deck). `money` in base currency. */
export function signalFacts(sig: SignalLike, base = "PLN"): { measured?: string; limit?: string; extra?: string } {
  const p = sig.payload;
  switch (sig.kind) {
    case "drawdown_from_high": return { measured: pct(-(n(p.drawdown) ?? 0)), limit: S.threshold(pctTarget(n(p.threshold))) };
    case "allocation_drift": {
      const over = n(p.drift_value_base);
      const target = n(p.target), abs = n(p.absolute_band_pp) ?? 5, rel = n(p.relative_band);
      const half = target != null && rel != null && rel > 0 ? Math.min(abs, rel * target * 100) : abs;
      return {
        measured: pp(n(p.drift_pp)), limit: S.band(pp(half).replace(/^\+/, "")),
        extra: over == null ? undefined : (over > 0 ? S.aboveTarget : S.belowTarget)(money0(Math.abs(over), s(p.currency) ?? base)),
      };
    }
    case "position_concentration": return { measured: pct(n(p.weight)), limit: S.max(pctTarget(n(p.max_weight))) };
    case "loss_from_cost":
    case "gain_from_cost": return { measured: pct(n(p.unrealized_pct), true), limit: S.threshold(pctTarget(n(p.threshold))) };
    case "cash_level": {
      const lim = p.direction === "above_max" ? S.max(pctTarget(n(p.max_weight))) : S.min(pctTarget(n(p.min_weight)));
      return { measured: pct(n(p.cash_weight)), limit: lim };
    }
    case "contribution_gap": {
      const last = s(p.last_deposit);
      const day = n(p.day_of_month);
      return {
        measured: last ? S.lastDeposit(dm(last)) : S.noDeposits,
        limit: S.depositPlan(day, n(p.grace_days) ?? 10),
      };
    }
    case "tagged_weight": return { measured: pct(n(p.weight)), limit: S.max(pctTarget(n(p.max_weight))) };
    default: return {};
  }
}

/** Latest decision's short label: "decyzja: dokupuję 20 szt." */
export function decisionTag(d: { action: string; quantity: number | null } | undefined): string | null {
  if (!d) return null;
  const q = d.quantity != null && (d.action === "bought" || d.action === "sold") ? S.pieces(qty(d.quantity)) : "";
  return S.decisionTag(DECISION_ACTION[d.action] ?? d.action, q);
}

/** Undecided first (action before review, newest first), decided at the bottom (design: a decided
 * signal moves to the bottom of the rail). */
export function orderSignals<T extends SignalLike>(list: T[]): T[] {
  const rank = (x: T) => (x.decisions.length ? 2 : 0) + (x.severity === "action" ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.id - a.id);
}

/** Next planned deposit date (contribution_gap "Odłóż do"): the plan's day in this or next month. */
export function nextDeposit(today: string, day: number | null): string {
  const [y, m, d] = today.split("-").map(Number);
  const want = day ?? 10;
  const last = (yy: number, mm: number) => new Date(yy, mm, 0).getDate();
  let yy = y, mm = m;
  if (d >= want) { mm += 1; if (mm > 12) { mm = 1; yy += 1; } }
  const dd = Math.min(want, last(yy, mm));
  return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

// ---- allocation ------------------------------------------------------------------

/** Rebalance band around a target: out of band when |drift| > absolute pp OR |drift| / target >
 * relative ("whichever first"), so the band's half-width is the narrower of the two. */
export function bandFor(target: number, policy: BandPolicy | null): [number, number] | null {
  if (!policy) return null;
  const abs = policy.absolute_band_pp / 100;
  const rel = policy.relative_band > 0 && target > 0 ? policy.relative_band * target : abs;
  const half = Math.min(abs, rel);
  return [Math.max(0, target - half), target + half];
}

/** Bar scale (design decision 9): max(target, current) + band over all rows, rounded up to 10 %. */
export function allocScale(rows: { weight: number | null; target?: number | null }[], policy: BandPolicy | null): number {
  const band = policy ? policy.absolute_band_pp / 100 : 0;
  const top = Math.max(0.1, ...rows.map((r) => Math.max(r.weight ?? 0, r.target ?? 0) + (r.target != null ? band : 0)));
  return Math.min(1, Math.ceil(top * 10 - 1e-9) / 10);
}

/** Effect of a planned trade on its bucket (buying with the account's cash keeps the total). */
export function decisionEffect(args: {
  side: "buy" | "sell"; quantity: number | null; price: number | null; currency: string;
  bucket: BucketLike | null; total: number; base: string;
}): string | null {
  const { side, quantity, price, bucket, total } = args;
  if (quantity == null || price == null || quantity <= 0 || price <= 0) return null;
  const amount = quantity * price;
  const head = `≈ ${money(amount, args.currency)}`;
  // A non-generic (the owner's own) bucket is not named in the app, nor are its target and drift (F7-generic).
  if (!bucket || !total || args.currency !== args.base || !bucketLabel(bucket.bucket_id)) return head;
  const after = (bucket.value + (side === "buy" ? amount : -amount)) / total;
  const drift = (after - bucket.target) * 100;
  const grows = Math.abs(drift) > Math.abs(bucket.drift_pp) + 1e-9;
  return S.effect(head, bucketLabel(bucket.bucket_id) ?? "", pct(after), pctTarget(bucket.target), grows, pp(drift));
}

// ---- weekly review ---------------------------------------------------------------

/** Is the weekly review due? The newest digest weekday on/before today is later than the last
 * review (or there was none). Mirrors the backend's review_due for mock data / older servers. */
export function reviewDue(today: string, digestWeekday: string, lastReview: string | null): boolean {
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(y, m - 1, d);
  const want = WEEKDAY_INDEX[digestWeekday] ?? 0;
  const back = (t.getDay() - want + 7) % 7;
  const digest = new Date(y, m - 1, d - back);
  if (!lastReview) return true;
  const [ly, lm, ld] = lastReview.slice(0, 10).split("-").map(Number);
  return new Date(ly, lm - 1, ld) < digest;
}

export interface ChangeRow {
  key: "value" | "import" | "signals" | "dividends" | "prices" | "strategy" | "decisions";
  label: string;
  main: string;
  sub: string;
  tone?: "pos" | "neg";
}

export interface DigestLike {
  since: string;
  as_of: string;
  value: { currency: string; then: number | null; now: number; change: number | null; change_pct: number | null };
  signals: { new: SignalLike[]; escalated: SignalLike[]; resolved: SignalLike[]; open: number; undecided: number };
  imports: { inserted: number; account_id: number; account_name?: string | null; created_at: string; new_instruments: number; file_name: string }[];
  transactions: { count: number; by_type: Record<string, number>; manual: number };
  decisions: { action: string }[];
  dividends: Record<string, number>;
  price_moves: { label: string; change_pct: number }[];
  warnings: { kind: string }[];
  stale_count: number;
  strategy: { version: number | null; state: string; changed_since: boolean };
}

/** The "Co się zmieniło" rows of the review band (only rows with something to say, plus value and
 * strategy which always say where things stand). */
export function changeRows(dg: DigestLike, accounts: AccountLike[] = []): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const c = dg.value.currency;
  if (dg.value.change != null && dg.value.then != null) {
    rows.push({
      key: "value", label: S.rowValue, tone: dg.value.change >= 0 ? "pos" : "neg",
      main: `${money(dg.value.change, c, true)}${dg.value.change_pct != null ? ` (${pct(dg.value.change_pct, true)})` : ""}`,
      sub: `${money(dg.value.then, c)} → ${money(dg.value.now, c)} · benchmark: -`,
    });
  } else {
    rows.push({ key: "value", label: S.rowValue, main: money(dg.value.now, c), sub: S.noStartValuation });
  }
  if (dg.imports.length || dg.transactions.count) {
    const imported = dg.imports.reduce((a, b) => a + b.inserted, 0);
    const byAcc = [...new Set(dg.imports.map((b) => {
      const acc = accounts.find((a) => a.id === b.account_id);
      return acc ? accountLabel(acc, accounts) : b.account_name ?? "";
    }))].filter(Boolean);
    const types = Object.entries(dg.transactions.by_type).sort((a, b) => b[1] - a[1])
      .map(([t, k]) => `${k} × ${txnType(t)}`).join(", ");
    const newInst = dg.imports.reduce((a, b) => a + b.new_instruments, 0);
    const parts = [types, newInst ? S.toClassify(nInstruments(newInst)) : "", dg.transactions.manual ? S.manualCount(dg.transactions.manual) : ""].filter(Boolean);
    rows.push({
      key: "import", label: S.rowImport,
      main: `${nTxns(imported || dg.transactions.count)}${byAcc.length ? S.fromAccounts(byAcc.join(", ")) : ""}${dg.imports[0] ? ` (${dm(dg.imports[0].created_at)})` : ""}`,
      sub: parts.join(" · "),
    });
  }
  const sg = dg.signals;
  if (sg.new.length || sg.escalated.length || sg.resolved.length) {
    const main = [
      sg.new.length ? S.nNew(sg.new.length) : "",
      sg.escalated.length ? S.nEscalated(sg.escalated.length) : "",
      sg.resolved.length ? S.nResolved(sg.resolved.length) : "",
    ].filter(Boolean).join(", ");
    const names = (l: SignalLike[]) => l.map((x) => signalTitle(x).replace(/^([A-Z\u0141\u015A\u017B])/, (m0) => m0.toLowerCase())).join(", ");
    const sub = [
      sg.new.length ? S.subNew(names(sg.new)) : "",
      sg.escalated.length ? S.subEscalated(names(sg.escalated)) : "",
      sg.resolved.length ? S.subResolved(names(sg.resolved)) : "",
    ].filter(Boolean).join(" · ");
    rows.push({ key: "signals", label: S.rowSignals, main, sub });
  }
  const divs = Object.entries(dg.dividends).filter(([, v]) => v);
  if (divs.length) {
    rows.push({ key: "dividends", label: S.rowDividends, tone: "pos", main: divs.map(([cc, v]) => money(v, cc, true)).join(" · "), sub: S.dividendsSub });
  }
  if (dg.stale_count || dg.price_moves.length) {
    const moves = dg.price_moves.slice(0, 3).map((m) => `${m.label} ${pct(m.change_pct, true)}`).join(", ");
    rows.push({
      key: "prices", label: S.rowPrices,
      main: dg.stale_count ? S.noFreshQuote(nInstruments(dg.stale_count)) : S.bigMoves(dg.price_moves.length),
      sub: moves ? S.biggestMoves(moves) : S.movesInWarnings,
    });
  }
  if (dg.decisions.length) {
    rows.push({ key: "decisions", label: S.rowDecisions, main: S.nDecisions(dg.decisions.length), sub: S.inJournal });
  }
  const st = dg.strategy;
  rows.push({
    key: "strategy", label: S.rowStrategy,
    main: st.version == null ? S.noStrategy : st.changed_since ? S.newVersion(st.version) : S.unchanged,
    sub: st.version == null ? S.strategyPending : `v${st.version}${st.state === "partial" ? S.someRulesInactive : st.state === "invalid" ? S.fileErrors : ""}`,
  });
  return rows;
}

/** Number of changes the header button announces ("Przegląd tygodnia · 5 zmian"). */
export function changeCount(dg: DigestLike): number {
  return dg.signals.new.length + dg.signals.escalated.length + dg.signals.resolved.length + dg.imports.length
    + (dg.transactions.manual ? 1 : 0) + (Object.values(dg.dividends).some(Boolean) ? 1 : 0) + dg.price_moves.length
    + (dg.strategy.changed_since ? 1 : 0);
}

// ---- warnings --------------------------------------------------------------------
export interface WarningItem { key: string; tone: "review" | "resolved"; title: string; hint: string; action?: "snapshot" | "alias" | "classify" | "import" }

/** Data warnings for the rail: portfolio warnings (titles by kind) plus account snapshot age.
 * `labels`: instrument id -> label; `accounts` for names; `today` for the snapshot age. */
export function warningItems(args: {
  warnings: { kind: string; message: string; account_id: number | null; instrument_id: number | null }[];
  labels: Map<string, string>;
  accounts: (AccountLike & { snapshot_date?: string | null; last_import?: { at: string } | null })[];
  stale: { instrument_id: number; label: string; price_date: string | null }[];
  missingFx: string[];
  today: string;
}): WarningItem[] {
  const out: WarningItem[] = [];
  const seen = new Set<string>();
  const add = (w: WarningItem) => { if (!seen.has(w.key)) { seen.add(w.key); out.push(w); } };
  const accName = (id: number | null) => {
    const a = args.accounts.find((x) => x.id === id);
    return a ? accountLabel(a, args.accounts) : S.account;
  };
  const inst = (id: number | null) => (id != null ? args.labels.get(String(id)) ?? S.instrumentN(id) : S.instrument);
  for (const a of args.accounts) {
    if (!a.last_import) continue; // nothing imported yet: nothing to reconcile
    const age = a.snapshot_date ? daysBetween(a.snapshot_date, args.today) : null;
    if (age == null) add({ key: `snap:${a.id}`, tone: "review", title: S.noSnapshot(accountLabel(a, args.accounts)), hint: S.noReconcile, action: "snapshot" });
    else if (age > 14) add({ key: `snap:${a.id}`, tone: "review", title: S.snapshotOld(accountLabel(a, args.accounts), dm(a.snapshot_date)), hint: S.noReconcile, action: "snapshot" });
  }
  for (const st of args.stale) {
    add({ key: `stale:${st.instrument_id}`, tone: "review", title: S.withTitle(st.label, S.stalePrice), hint: st.price_date ? S.lastQuote(dm(st.price_date)) : S.noQuotes, action: "alias" });
  }
  for (const c of args.missingFx) {
    add({ key: `fx:${c}`, tone: "resolved", title: S.fxUnavailable(c), hint: S.fxSkipped });
  }
  const unknownCost = new Map<string, number>();
  for (const w of args.warnings) {
    const fx = /([A-Z]{3})\/[A-Z]{3}/.exec(w.message)?.[1];
    switch (w.kind) {
      case "stale_price":
      case "last_known_price_used":
        add({ key: `stale:${w.instrument_id}`, tone: "review", title: S.withTitle(inst(w.instrument_id), w.kind === "stale_price" ? S.stalePrice : S.lastTradePrice), hint: S.checkAlias, action: "alias" });
        break;
      case "missing_price":
        add({ key: `price:${w.instrument_id}`, tone: "review", title: S.withTitle(inst(w.instrument_id), S.noPrice), hint: S.positionSkipped, action: "alias" });
        break;
      case "missing_fx_rate":
      case "stale_fx_rate":
        add({ key: `fx:${fx ?? w.message}`, tone: "resolved", title: S.fxRate(fx ?? "", w.kind === "stale_fx_rate").replace("  ", " "), hint: S.refreshesNextRun });
        break;
      case "unknown_cost_basis":
      case "missing_cost_basis": {
        const k = String(w.instrument_id ?? "?");
        unknownCost.set(k, (unknownCost.get(k) ?? 0) + 1);
        break;
      }
      case "history_gap":
        add({ key: `gap:${w.account_id}:${w.instrument_id}`, tone: "review", title: S.historyGap(accName(w.account_id)), hint: S.historyGapHint(inst(w.instrument_id)), action: "import" });
        break;
      case "cash_history_gap":
        add({ key: `cash:${w.account_id}`, tone: "review", title: S.negativeCash(accName(w.account_id)), hint: S.negativeCashHint, action: "import" });
        break;
      case "frozen_valued_at_zero":
      case "missing_manual_valuation":
        add({ key: `manual:${w.instrument_id}`, tone: "review", title: S.withTitle(inst(w.instrument_id), S.noManualValuation), hint: S.valuedAtZero });
        break;
      case "missing_instrument":
        add({ key: `inst:${w.instrument_id}`, tone: "review", title: S.withTitle(inst(w.instrument_id), S.noInstrumentData), hint: S.substituteValuation });
        break;
      default:
        add({ key: `${w.kind}:${w.account_id}:${w.instrument_id}`, tone: "resolved", title: S.dataWarning, hint: w.message });
    }
  }
  const lots = [...unknownCost.values()].reduce((a, b) => a + b, 0);
  if (lots) add({ key: "cost", tone: "review", title: S.noCostBasis(lots), hint: S.noCostBasisHint, action: "import" });
  return out;
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.slice(0, 10).split("-").map(Number);
  const [by, bm, bd] = b.slice(0, 10).split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// ---- manual transaction form ---------------------------------------------------------
export type Need = "required" | "optional" | "none";
export interface TxnRule { instrument: Need; quantity: Need; price: Need; amount: Need; split: boolean; sign: "out" | "in" | "neutral" | "any" }

/** What the manual form asks for per type (docs/import-format.md section 4, mirrored by the
 * backend's validation). `amount` is the gross amount for cash events. */
export const TXN_RULES: Record<string, TxnRule> = {
  buy: { instrument: "required", quantity: "required", price: "required", amount: "none", split: false, sign: "out" },
  sell: { instrument: "required", quantity: "required", price: "required", amount: "none", split: false, sign: "in" },
  dividend: { instrument: "optional", quantity: "optional", price: "none", amount: "required", split: false, sign: "in" },
  interest: { instrument: "optional", quantity: "none", price: "none", amount: "required", split: false, sign: "in" },
  deposit: { instrument: "none", quantity: "none", price: "none", amount: "required", split: false, sign: "in" },
  withdrawal: { instrument: "none", quantity: "none", price: "none", amount: "required", split: false, sign: "out" },
  fee: { instrument: "optional", quantity: "none", price: "none", amount: "required", split: false, sign: "out" },
  tax: { instrument: "optional", quantity: "none", price: "none", amount: "required", split: false, sign: "out" },
  split: { instrument: "required", quantity: "none", price: "none", amount: "none", split: true, sign: "neutral" },
  transfer_in: { instrument: "required", quantity: "required", price: "optional", amount: "none", split: false, sign: "neutral" },
  transfer_out: { instrument: "required", quantity: "required", price: "none", amount: "none", split: false, sign: "neutral" },
  adjustment: { instrument: "required", quantity: "required", price: "optional", amount: "none", split: false, sign: "neutral" },
};

export interface TxnFormValues { type: string; hasInstrument: boolean; quantity: number | null; price: number | null; amount: number | null; fee: number | null; split: number | null; date: string }

/** Client-side check of the manual form; returns messages per field (empty = ok). */
export function validateTxn(v: TxnFormValues, today: string): Record<string, string> {
  const r = TXN_RULES[v.type];
  const e: Record<string, string> = {};
  if (!r) return { type: S.errType };
  if (!v.date) e.date = S.errDate;
  else if (v.date > today) e.date = S.errFutureDate;
  if (r.instrument === "required" && !v.hasInstrument) e.instrument = S.errInstrument;
  if (r.quantity === "required" && !(v.quantity != null && v.quantity > 0)) e.quantity = S.errQtyPositive;
  if (r.quantity === "optional" && v.quantity != null && v.quantity < 0) e.quantity = S.errQtyNegative;
  if (r.price === "required" && !(v.price != null && v.price > 0)) e.price = S.errPrice;
  if (r.price === "optional" && v.price != null && v.price < 0) e.price = S.errPriceNegative;
  if (r.amount === "required" && !(v.amount != null && v.amount > 0)) e.amount = S.errAmount;
  if (v.fee != null && v.fee < 0) e.fee = S.errFee;
  if (r.split && !(v.split != null && v.split > 0)) e.split = S.errSplit;
  return e;
}

/** Cash effect of the manual form (signed, trade currency) for the summary line. */
export function txnCash(v: Pick<TxnFormValues, "type" | "quantity" | "price" | "amount" | "fee">): number | null {
  const r = TXN_RULES[v.type];
  if (!r || r.sign === "neutral") return r ? 0 : null;
  const gross = r.amount !== "none" ? v.amount : v.quantity != null && v.price != null ? v.quantity * v.price : null;
  if (gross == null) return null;
  const fee = v.fee ?? 0;
  return r.sign === "out" ? -(gross + fee) : gross - fee;
}

/** Import preview counts -> what the commit button says: "Zaimportuj 14 transakcji i 1 korektę". */
export function commitLabel(newRows: number, corrections: number): string {
  return S.commit(newRows, corrections);
}

/** "{n} koszyk(i) poza pasmem" / "wszystko w paśmie". */
export function bandTag(outOfBand: number): string {
  return outOfBand ? S.bandOut(outOfBand) : S.allInBand;
}

export { assetClass };

/** A rule run error (backend, English) -> short text for the Reguły KPI. */
export function runError(msg: string | null | undefined): string {
  if (!msg) return "";
  // Never the strategy's rule id (FE-A A6 sweep).
  if (/^rule (\S+) inactive/i.test(msg)) return S.ruleInactive;
  if (/stooq|yahoo|nbp|price source|timed? ?out|connect|network|http/i.test(msg)) return S.priceSourceDown;
  if (/strategy/i.test(msg)) return S.strategyProblem;
  return msg.length > 80 ? `${msg.slice(0, 77)}…` : msg;
}
