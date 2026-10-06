// v2 investments logic without React: polarity split of the signals, signal and alert copy in plain words
// (no rule ids), alert distance to level, the alert form's default title and preview sentence, weekly change
// from 30-day closes, re-entry gap, change-log grouping, performance facts. Pure; `npm test` imports it
// (node strips the types; imports carry their .ts extension).
import { ASSET_CLASS, bucketLabel, DECISION_ACTION, dm, GENERIC_BUCKET_IDS, isGenericBucket, micName, money, money0, pct, pctTarget, plural, pp, qty, REGION, txnType, WEEKDAY_INDEX } from "../labels.ts";
import { isResearchKind, researchSignalText } from "./research/logic.ts";
import { localDay, parseServerTime, serverDate } from "../../../time.ts";
import { describePerfNote } from "../../../core/messages.ts";

export type Polarity = "positive" | "negative" | "neutral";

/** Default polarity per rule kind (mirrors rules/kinds DEFAULT_POLARITY) for servers without the field. */
const KIND_POLARITY: Record<string, Polarity> = {
  drawdown_from_high: "positive", gain_from_cost: "positive", loss_from_cost: "negative", allocation_drift: "neutral",
  cash_level: "negative", contribution_gap: "negative", position_concentration: "negative", tagged_weight: "negative", custom: "neutral",
};

export interface SigLike {
  id: number;
  rule_id: string;
  kind: string;
  severity: string;
  status: string;
  message: string;
  polarity?: string;
  source?: string;
  alert_id?: number | null;
  instrument_id: number | null;
  instrument_label: string | null;
  payload: Record<string, unknown>;
  first_seen_at: string | null;
  decisions: { action: string; quantity: number | null; created_at: string | null }[];
  snoozed?: boolean;
  last_seen_at?: string | null;
  /** F8 BE: the profile's last non-failed run confirmed it (research signals: true). */
  current?: boolean | null;
  /** F8 BE: the instrument is held in any account of the profile (null for portfolio-wide signals). */
  held?: boolean | null;
}

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function polarityOf(sig: Pick<SigLike, "polarity" | "kind">): Polarity {
  if (sig.polarity === "positive" || sig.polarity === "negative" || sig.polarity === "neutral") return sig.polarity;
  return KIND_POLARITY[sig.kind] ?? "neutral";
}

export const isDecided = (sig: Pick<SigLike, "decisions">) => sig.decisions.length > 0;

// ---- generic allocation interface (F7-generic) -------------------------------------------------------------
// The owner's own strategy buckets are internal knowledge for the agent: the app names, targets and signals only
// generic buckets (template and plain asset-class ids, labels.ts). A missing server flag counts as generic; an id
// the app cannot name counts as not generic, so no bucket id is ever rendered raw.

/** Whether a signal shows anywhere in the app (lists, counts, links): every signal except an allocation drift of
 * a non-generic bucket (`payload.bucket_generic === false`, or an id without a generic label). */
export function isShownSignal(sig: Pick<SigLike, "kind" | "payload">): boolean {
  if (sig.kind !== "allocation_drift") return true;
  const id = typeof sig.payload?.bucket_id === "string" ? sig.payload.bucket_id : null;
  return sig.payload?.bucket_generic !== false && isGenericBucket(id);
}

/** Expression bucket functions over a non-generic bucket, shown as a Polish phrase instead of the call. */
const BUCKET_FN: Record<string, string> = { bucket_weight: "waga koszyka", bucket_target: "cel koszyka", bucket_drift_pp: "dryf koszyka", bucket_value: "wartość koszyka" };
/** ASCII words that may follow "koszyk" in owner-written text and are never bucket ids. */
const NOT_BUCKET_IDS = new Set(["na", "do", "od", "nad", "pod", "ponad", "w", "z", "i", "o", "za", "przy", "bez", "ma", "jest", "waga", "udzial", "akcji", "obligacji", "gotowki", "przekracza", "spada", "rosnie", "powyzej", "ponizej"]);
const ID_LIKE = /^[A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+)*$/;
let labelWords: Set<string> | null = null;
/** First words of the generic labels (`Akcje`, `Obligacje`, `ETF-y`, ...): already a label, never an id. */
const isLabelWord = (w: string) => (labelWords ??= new Set(GENERIC_BUCKET_IDS.map((id) => (bucketLabel(id) ?? "").split(" ")[0].toLowerCase()))).has(w.toLowerCase());

/** Texts that may carry the owner's bucket ids, made safe to show (F7-generic, FE-A A2 / A3): server-built prose
 * (`Koszyk core: ...` from a bucket-scoped custom rule, `Koszyk core` as an alert subject; any case) gets the generic
 * label or drops the id (`Koszyk: ...`); expression text (custom-rule default messages `Warunek spełniony: <when>`,
 * custom alert expressions) shows `bucket_drift_pp("core")` as `dryf koszyka` (likewise waga / cel / wartość
 * koszyka) and a `bucket_id == "core"` literal as `"…"`. Generic ids stay as written; idempotent. */
export function unnameBuckets(text: string): string {
  return text
    .replace(/\b(bucket_(?:weight|target|drift_pp|value))\(\s*(["'])([^"']*)\2\s*\)/g, (m, fn: string, _q: string, id: string) => (isGenericBucket(id) ? m : BUCKET_FN[fn]))
    .replace(/\bbucket_id(\s*[!=]=\s*)(["'])([^"']*)\2/g, (m, op: string, q: string, id: string) => (isGenericBucket(id) || id === "…" ? m : `bucket_id${op}${q}…${q}`))
    .replace(/(["'])([^"']*)\1(\s*[!=]=\s*)bucket_id\b/g, (m, q: string, id: string, op: string) => (isGenericBucket(id) || id === "…" ? m : `${q}…${q}${op}bucket_id`))
    .replace(/\b([Kk]oszyk) ([^\s:,;()"']+)(?=([:\s,;)]|$))/g, (m, kw: string, tok: string, next: string) => {
      if (isLabelWord(tok)) return m;
      const id = next === ":" || (ID_LIKE.test(tok) && !NOT_BUCKET_IDS.has(tok.toLowerCase()));
      if (!id) return m;
      const l = bucketLabel(tok);
      return l ? `${kw} ${l}` : kw;
    });
}

/** Rule kinds in Polish (a rule's strategy id never reaches the UI, FE-A A6). */
export const RULE_KIND_LABEL: Record<string, string> = {
  drawdown_from_high: "transza spadkowa", gain_from_cost: "zysk od kosztu", loss_from_cost: "strata od kosztu", allocation_drift: "dryf alokacji",
  position_concentration: "koncentracja", contribution_gap: "brak wpłaty", cash_level: "poziom gotówki", tagged_weight: "udział tagów",
  custom: "reguła własna",
};
export const ruleKindLabel = (kind: string | null | undefined): string => (kind ? RULE_KIND_LABEL[kind] ?? (kind.startsWith("alert:") ? "alert" : "reguła") : "reguła");

/** Whether the allocation's buckets (targets, drift, `Koszyki`) may show: at least one bucket and every bucket
 * generic (`buckets_generic` / `generic` from the server, a missing key = generic, plus a generic label). */
export function allocGeneric(alloc: { buckets: { bucket_id: string; generic?: boolean | null }[]; buckets_generic?: boolean | null }): boolean {
  return alloc.buckets.length > 0 && alloc.buckets_generic !== false && alloc.buckets.every((b) => b.generic !== false && isGenericBucket(b.bucket_id));
}

/** A review digest without the signals that never show (lists by `isShownSignal`, drift events by bucket). */
export function digestShown<D extends { signals?: { new: SigLike[]; escalated: SigLike[]; resolved: SigLike[] } & Record<string, unknown>; events?: { kind?: string; bucket_id?: string | null }[] }>(d: D): D {
  const sig = d.signals ? { ...d.signals, new: d.signals.new.filter(isShownSignal), escalated: d.signals.escalated.filter(isShownSignal), resolved: d.signals.resolved.filter(isShownSignal) } : d.signals;
  const events = d.events?.filter((e) => e.kind !== "allocation_drift" || isGenericBucket(e.bucket_id ?? null));
  return { ...d, signals: sig, ...(d.events ? { events } : {}) };
}

/** Newest first by `first_seen_at` (a missing time counts as the oldest), then action before info, then the
 * higher id (signals-rail.md 2-3: the rail's rows and the dialog's columns share this order). */
function byTime<T extends SigLike>(a: T, b: T): number {
  const time = (x: T) => { const t = parseServerTime(x.first_seen_at); return Number.isNaN(t) ? -Infinity : t; };
  const ta = time(a), tb = time(b);
  return (ta === tb ? 0 : tb > ta ? 1 : -1) || (a.severity === "action" ? 0 : 1) - (b.severity === "action" ? 0 : 1) || b.id - a.id;
}
const settled = (x: SigLike) => isDecided(x) || !!x.snoozed;

/** Signals in two columns (ia-v2 6): Szanse = positive; Ryzyka i przegląd = negative and neutral. Within a
 * column (signals-rail.md 3): undecided before decided or snoozed, then newest first, action before info. */
export function splitByPolarity<T extends SigLike>(list: T[]): { positive: T[]; negative: T[] } {
  const sorted = [...list].sort((a, b) => Number(settled(a)) - Number(settled(b)) || byTime(a, b));
  return { positive: sorted.filter((x) => polarityOf(x) === "positive"), negative: sorted.filter((x) => polarityOf(x) !== "positive") };
}

// ---- signals by subject and scope (home v3, Q4 / Q6: design/v3/home-v3/home-v3.md 6) ---------------------

export type SigScope = "portfolio" | "watched";
/** Portfel = portfolio-wide, a bucket, or a held instrument; Obserwowane = an instrument that is not held. The
 * server's `held` (F8) wins; else the `held` set (instrument ids as strings). */
export const signalScope = (s: Pick<SigLike, "instrument_id" | "held">, held: Set<string>): SigScope =>
  s.instrument_id == null || (typeof s.held === "boolean" ? s.held : held.has(String(s.instrument_id))) ? "portfolio" : "watched";

/** One subject per row: the instrument, the bucket of a drift signal, else the rule kind (contribution_gap, ...). */
export const subjectKey = (s: Pick<SigLike, "kind" | "instrument_id" | "payload">): string =>
  s.instrument_id != null ? `i:${s.instrument_id}` : s.kind === "allocation_drift" ? `b:${String(s.payload.bucket_id ?? "")}` : `k:${s.kind}`;

export type SigState = "positive" | "negative" | "neutral" | "mixed";
/** positive only -> positive; no positive -> negative when any negative, else neutral; positive with anything
 * else -> mixed; nothing -> null. */
export function stateOf(pols: Polarity[]): SigState | null {
  if (!pols.length) return null;
  if (pols.includes("positive")) return pols.every((p) => p === "positive") ? "positive" : "mixed";
  return pols.includes("negative") ? "negative" : "neutral";
}
/** The glyph's title: `szansa` / `ryzyko` / `sygnał` / `szansa i ryzyko`. */
export const STATE_LABEL: Record<SigState, string> = { positive: "szansa", negative: "ryzyko", neutral: "sygnał", mixed: "szansa i ryzyko" };

export interface SignalGroup<T> {
  key: string;
  instrumentId: number | null;
  /** Every signal of the subject, byTime order. */
  signals: T[];
  /** Not decided and not snoozed, byTime order. */
  live: T[];
  state: SigState;
  /** live[0]: the newest (action first on a tie). */
  primary: T | null;
  /** No live signal. */
  settled: boolean;
}

/** Groups by `subjectKey`. `state` over the live signals (over all when none is live). Order: unsettled groups
 * by their primary (byTime), then settled groups by their newest signal. */
export function groupSignals<T extends SigLike>(list: T[]): SignalGroup<T>[] {
  const by = new Map<string, T[]>();
  for (const x of list) {
    const k = subjectKey(x);
    const g = by.get(k);
    if (g) g.push(x); else by.set(k, [x]);
  }
  const groups = [...by].map(([key, sigs]): SignalGroup<T> => {
    const all = [...sigs].sort(byTime);
    const live = all.filter((x) => !settled(x));
    return { key, instrumentId: all[0].instrument_id, signals: all, live, state: stateOf((live.length ? live : all).map((x) => polarityOf(x)))!, primary: live[0] ?? null, settled: !live.length };
  });
  return groups.sort((a, b) => Number(a.settled) - Number(b.settled) || byTime(a.primary ?? a.signals[0], b.primary ?? b.signals[0]));
}

/** One rail section: the unsettled groups of the scope, at most `n`. */
export function railGroups<T extends SigLike>(list: T[], held: Set<string>, scope: SigScope, n = 4): SignalGroup<T>[] {
  return groupSignals(list.filter((x) => signalScope(x, held) === scope)).filter((g) => !g.settled).slice(0, n);
}

/** The rail's rows in reading order (Portfel, then Obserwowane): the j / k cursor walks groups. */
export const railRows = <T extends SigLike>(list: T[], held: Set<string>, n = 4): SignalGroup<T>[] =>
  [...railGroups(list, held, "portfolio", n), ...railGroups(list, held, "watched", n)];

/** A notification link lands in the rail when its signal is live in one of the rail's groups, else in the dialog. */
export const signalPlace = (id: number, list: SigLike[], held: Set<string>): "rail" | "dialog" =>
  (railRows(list, held).some((g) => g.live.some((x) => x.id === id)) ? "rail" : "dialog");

/** Rail group actions (architect default, F8): Potwierdź acknowledges every live signal; Zanotuj posts the
 * decision to `primary` and acknowledges `rest` with the reason `decyzja: <tag>`. */
export const groupPlan = <T>(g: Pick<SignalGroup<T>, "primary" | "live">): { primary: T; rest: T[] } | null =>
  (g.primary == null ? null : { primary: g.primary, rest: g.live.slice(1) });

/** Polarity filter of the dialog (`Wszystkie | Szanse n | Ryzyka n`). */
export type SignalFilter = "all" | "positive" | "negative";
const passes = (x: SigLike, f: SignalFilter) => f === "all" || (polarityOf(x) === "positive") === (f === "positive");

/** The dialog's columns by scope; the polarity filter keeps only the signals of that polarity (Ryzyka = negative
 * and neutral) and drops the groups left empty. */
export function splitByScope<T extends SigLike>(list: T[], held: Set<string>, filter: SignalFilter): { portfolio: SignalGroup<T>[]; watched: SignalGroup<T>[] } {
  const keep = list.filter((x) => passes(x, filter));
  return {
    portfolio: groupSignals(keep.filter((x) => signalScope(x, held) === "portfolio")),
    watched: groupSignals(keep.filter((x) => signalScope(x, held) === "watched")),
  };
}

/** Undecided signals in reading order (Portfel groups, then Obserwowane): the dialog's cursor. */
export function cursorOrder<T extends SigLike>(list: T[], held: Set<string>, filter: SignalFilter = "all"): T[] {
  const { portfolio, watched } = splitByScope(list, held, filter);
  return [...portfolio, ...watched].flatMap((g) => g.live);
}

/** Whether the rules confirmed an open signal in the profile's last non-failed run: the server's `current` when
 * sent; else true unless that run finished on a later local day than the signal's `last_seen_at`. Research
 * signals are always current. */
export function signalCurrent(s: { current?: boolean | null; last_seen_at?: string | null; kind: string }, lastRunAt: string | null): boolean {
  if (typeof s.current === "boolean") return s.current;
  if (isResearchKind(s.kind) || !lastRunAt || !s.last_seen_at) return true;
  return (localDay(lastRunAt) ?? "") <= (localDay(s.last_seen_at) ?? "");
}

/** Short name of a signal's subject (rail line 1): an instrument's ticker (`instMono`), a bucket's label, a
 * portfolio rule's short title (`Brak wpłaty`, `Za mało gotówki`, `Udział: tagi`). `insts`: instrument id ->
 * symbol / name (positions, watchlist) when the payload carries no symbol. */
export function signalSubject(sig: SigLike, insts?: Map<number, { symbol?: string | null; name?: string | null; label: string }>): string {
  if (sig.instrument_id != null) {
    const i = insts?.get(Number(sig.instrument_id));
    const symbol = s(sig.payload.symbol) ?? i?.symbol ?? null;
    const name = i ? instName(i) : s(sig.payload.name) ?? sig.instrument_label ?? "";
    return symbol ? instMono({ symbol, name, label: name }) : name || "Instrument";
  }
  if (sig.kind === "allocation_drift") return bucketLabel(s(sig.payload.bucket_id)) ?? "Alokacja";
  return signalText(sig).title;
}

/** One measurable fact of a signal (rail / dialog line 2, rev 2 7.5): `{pre} <b>{bold}</b>{post}`; no threshold,
 * no `·` chains (those stay in `signalText` for the title and the journal). `post` starting with a comma joins
 * without a space. */
export interface SigFact { pre?: string; bold: string; post?: string }
export function signalFact(sig: SigLike): SigFact {
  const p = sig.payload;
  if (isResearchKind(sig.kind)) {
    const t = researchSignalText(sig, "", null);
    return { pre: t.lead?.replace(/\s*·$/, ""), bold: t.bold ?? "" };
  }
  if (sig.kind.startsWith("alert:")) return alertFactOf(s(p.alert_kind) ?? sig.kind.slice("alert:".length), p);
  switch (sig.kind) {
    case "drawdown_from_high": return { bold: pct(-(n(p.drawdown) ?? 0)), post: `od szczytu ${win(n(p.window_days) ?? 252)}` };
    case "gain_from_cost": case "loss_from_cost": return { bold: signedPct(n(p.unrealized_pct)), post: "od kosztu" };
    case "position_concentration": return { bold: pct(n(p.weight)), post: `portfela, maks ${pctTarget(n(p.max_weight))}` };
    case "allocation_drift": {
      const d = n(p.drift_pp) ?? 0;
      return { bold: pp(d), post: `${d > 0 ? "nad celem" : "do celu"} ${pctTarget(n(p.target))}` };
    }
    case "contribution_gap": {
      const last = s(p.last_deposit);
      return last ? { pre: "ostatnia wpłata", bold: dm(last) } : { bold: "brak wpłat" };
    }
    case "cash_level": {
      const above = p.direction === "above_max";
      return { pre: "gotówka", bold: pct(n(p.cash_weight)), post: above ? `, maks ${pctTarget(n(p.max_weight))}` : `, min ${pctTarget(n(p.min_weight))}` };
    }
    case "tagged_weight": return { bold: pct(n(p.weight)), post: `portfela, maks ${pctTarget(n(p.max_weight))}` };
    default: return { pre: unnameBuckets(sig.message || "") || "Reguła własna", bold: "" };
  }
}

/** `x` ratio with one decimal: 3.4 -> "3,4x". */
export const ratioX = (v: number | null) => (v == null ? "-" : `${v.toLocaleString("pl-PL", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}x`);

function alertFactOf(kind: string, p: Record<string, unknown>): SigFact {
  const c = s(p.currency);
  switch (kind) {
    case "price_below": case "price_above":
      return { pre: "cena", bold: price(n(p.close), c), post: `${kind === "price_below" ? "poniżej" : "powyżej"} ${price(n(p.level), c)}` };
    case "change_pct": return { bold: signedPct(n(p.change)), post: `w ${n(p.window_days) ?? "-"} sesji` };
    case "drawdown_from_high": return { bold: pct(-(n(p.drawdown) ?? 0)), post: `od szczytu ${win(n(p.window_days) ?? 252)}` };
    case "new_high": return { pre: p.direction === "low" ? "nowy dołek" : "nowy szczyt", bold: price(n(p.close), c) };
    case "sma_cross": return { bold: price(n(p.close), c), post: `${p.direction === "above" ? "nad" : "pod"} SMA ${n(p.window_days) ?? 200}` };
    case "weight_above": case "weight_below":
      return { bold: pct(n(p.weight)), post: `portfela, ${kind === "weight_above" ? "powyżej" : "poniżej"} ${pctTarget(n(p.threshold))}` };
    case "range_breakout": {
      const b = n(p.breakout_pct);
      return { pre: "wybicie", bold: breakoutPct(b), post: b != null && b < 0 ? `pod ${price(n(p.range_low), c)}` : `nad ${price(n(p.range_high), c)}` };
    }
    case "volume_spike": return { pre: "wolumen", bold: ratioX(n(p.ratio)), post: "średniej" };
    default: return { pre: unnameBuckets(s(p.title) ?? "") || "Alert", bold: "" };
  }
}

// ---- signal copy -------------------------------------------------------------------------------------

export interface SigText { title: string; sym: string | null; lead?: string; bold?: string; tail?: string }

const win = (days: number | null) => (days == null ? "" : days >= 250 ? "52 tyg." : `${days} sesji`);
const signedPct = (v: number | null) => (v == null ? "-" : pct(v, true));
/** A breakout's size vs the range edge; under 0,05 % it would read "+0,0 %", so "tuż" (F8 review BE-7). */
const breakoutPct = (v: number | null) => (v != null && Math.abs(v) < 0.0005 ? "tuż" : signedPct(v));

/** Price with currency (2 decimals): "30,00 €", "148,60 zł". */
export const price = (v: number | null | undefined, c?: string | null) => (v == null || !Number.isFinite(v) ? "-" : money(v, c || "PLN"));

/** Display name of an instrument: the name when it differs from the symbol (a manual instrument's label
 * is its symbol), else the label. */
export function instName(i: { name?: string | null; label: string; symbol?: string | null }): string {
  return i.name && i.name !== i.symbol ? i.name : i.label;
}

/** Plain-words copy of a signal (no rule ids): title, muted symbol, one fact line `lead <b>bold</b> tail`.
 * `names`: instrument id -> display name (positions / watchlist) when the payload carries none. */
export function signalText(sig: SigLike, ctx: { total?: number | null; base?: string; names?: Map<number, string> } = {}): SigText {
  const p = sig.payload;
  const name = s(p.name) ?? (sig.instrument_id != null ? ctx.names?.get(sig.instrument_id) : undefined) ?? sig.instrument_label ?? s(p.symbol) ?? "";
  const sym = s(p.symbol) && s(p.symbol) !== name ? s(p.symbol) : null;
  const base = ctx.base ?? "PLN";
  if (sig.kind.startsWith("alert:")) return alertSignalText(sig, name, sym);
  if (isResearchKind(sig.kind)) return researchSignalText(sig, name, sym);
  switch (sig.kind) {
    case "drawdown_from_high":
      return { title: name, sym, lead: "transza spadkowa ·", bold: pct(-(n(p.drawdown) ?? 0)), tail: `od szczytu ${win(n(p.window_days) ?? 252)} · próg -${pctTarget(n(p.threshold))}` };
    case "gain_from_cost":
      return { title: name, sym, lead: "zysk od kosztu ·", bold: signedPct(n(p.unrealized_pct)), tail: `próg +${pctTarget(n(p.threshold))}` };
    case "loss_from_cost":
      return { title: name, sym, lead: "strata od kosztu ·", bold: signedPct(n(p.unrealized_pct)), tail: `próg -${pctTarget(n(p.threshold))}` };
    case "position_concentration": {
      const w = n(p.weight), max = n(p.max_weight);
      const over = w != null && max != null && ctx.total ? (w - max) * ctx.total : null;
      return { title: `Koncentracja: ${name}`, sym, bold: pct(w), tail: `portfela · maks ${pctTarget(max)}${over != null && over > 0 ? ` · ≈ ${money0(over, base)} nad limitem` : ""}` };
    }
    case "allocation_drift": {
      const drift = n(p.drift_pp) ?? 0, target = n(p.target);
      const abs = n(p.absolute_band_pp) ?? 5, rel = n(p.relative_band);
      const half = target != null && rel != null && rel > 0 ? Math.min(abs, rel * target * 100) : abs;
      const value = n(p.drift_value_base);
      // Only generic buckets reach the UI (isShownSignal); the fallback never names an id.
      const bucket = bucketLabel(s(p.bucket_id)) ?? "Alokacja";
      return {
        title: drift > 0 ? `${bucket} poza pasmem` : `${bucket} poniżej celu`, sym: null, bold: pp(drift),
        tail: `${drift > 0 ? "nad celem" : "do celu"} ${pctTarget(target)} · pasmo ±${pp(half).replace(/^\+/, "")}${value != null ? ` · ≈ ${money0(Math.abs(value), s(p.currency) ?? base)}` : ""}`,
      };
    }
    case "contribution_gap": {
      const day = n(p.day_of_month), last = s(p.last_deposit);
      return { title: "Brak wpłaty", sym: null, lead: last ? "ostatnia" : undefined, bold: last ? dm(last) : "brak wpłat", tail: `· plan: co miesiąc${day ? ` do ${day}.` : ""} (+${n(p.grace_days) ?? 10} dni)` };
    }
    case "cash_level": {
      const above = p.direction === "above_max";
      return { title: above ? "Za dużo gotówki" : "Za mało gotówki", sym: null, bold: pct(n(p.cash_weight)), tail: `portfela · ${above ? `maks ${pctTarget(n(p.max_weight))}` : `min ${pctTarget(n(p.min_weight))}`}` };
    }
    case "tagged_weight":
      return { title: `Udział: ${Array.isArray(p.tags) ? p.tags.join(", ") : "tagi"}`, sym: null, bold: pct(n(p.weight)), tail: `portfela · maks ${pctTarget(n(p.max_weight))}` };
    default:
      return { title: unnameBuckets(sig.message || "") || "Reguła własna", sym: null, tail: name || undefined };
  }
}

function alertSignalText(sig: SigLike, name: string, sym: string | null): SigText {
  const p = sig.payload;
  const kind = s(p.alert_kind) ?? sig.kind.slice("alert:".length);
  const title = name || unnameBuckets(s(p.title) ?? "") || "Alert";
  const c = s(p.currency);
  switch (kind) {
    case "price_below":
    case "price_above":
      return { title, sym, lead: kind === "price_below" ? "cena poniżej" : "cena powyżej", bold: price(n(p.level), c), tail: `· teraz ${price(n(p.close), c)}` };
    case "change_pct": {
      const ch = n(p.change);
      return { title, sym, bold: signedPct(ch), tail: `w ${n(p.window_days) ?? "-"} sesji · próg ${p.direction === "down" ? "-" : p.direction === "up" ? "+" : "±"}${pctTarget(n(p.threshold))}` };
    }
    case "drawdown_from_high":
      return { title, sym, lead: "spadek od szczytu", bold: pct(-(n(p.drawdown) ?? 0)), tail: `· ${win(n(p.window_days))} · próg -${pctTarget(n(p.threshold))}` };
    case "new_high":
      return { title, sym, lead: "nowy szczyt", bold: price(n(p.close), c), tail: `· ${win(n(p.window_days))}` };
    case "sma_cross":
      return { title, sym, lead: `przecięcie SMA ${n(p.window_days) ?? ""} ${p.direction === "above" ? "w górę" : "w dół"} ·`, bold: price(n(p.close), c), tail: n(p.sma) != null ? `· SMA ${price(n(p.sma), c)}` : undefined };
    case "range_breakout": {
      const b = n(p.breakout_pct);
      return { title, sym, lead: `wybicie z konsolidacji ${n(p.window_days) ?? 30} sesji ·`, bold: breakoutPct(b), tail: b != null && b < 0 ? `pod ${price(n(p.range_low), c)}` : `nad ${price(n(p.range_high), c)}` };
    }
    case "volume_spike":
      return { title, sym, lead: "wolumen", bold: ratioX(n(p.ratio)), tail: `średniej ${n(p.window_days) ?? 20} sesji · teraz ${price(n(p.close), c)}` };
    case "weight_above":
    case "weight_below":
      return { title: bucketLabel(s(p.bucket_id)) ?? title, sym, bold: pct(n(p.weight)), tail: `portfela · ${kind === "weight_above" ? "powyżej" : "poniżej"} ${pctTarget(n(p.threshold))}` };
    default:
      return { title: s(p.title) ?? title, sym, tail: s(p.title) && name ? name : undefined };
  }
}

// ---- alerts ------------------------------------------------------------------------------------------

export interface AlertLike {
  kind: string;
  scope: string;
  params: Record<string, unknown>;
  polarity: string;
  severity: string;
  title: string;
  status: string;
  source: string;
  last_value: number | null;
  cooldown_days: number | null;
  expires_at: string | null;
  snoozed_until?: string | null;
  last_triggered_at?: string | null;
  instrument?: { label: string; symbol: string | null; currency: string } | null;
  /** Per-run values of the dynamic kinds (F8 BE, optional): `range_low` / `range_high` / `range_pct`
   * (range_breakout), `average_volume` (volume_spike). */
  state?: { range_low?: number | string | null; range_high?: number | string | null; range_pct?: number | string | null; average_volume?: number | string | null } | null;
}

export const KIND_LABEL: Record<string, string> = {
  price_above: "Cena powyżej", price_below: "Cena poniżej", change_pct: "Zmiana % w oknie", drawdown_from_high: "Spadek od szczytu",
  new_high: "Nowy szczyt", sma_cross: "Przecięcie SMA", weight_above: "Waga powyżej", weight_below: "Waga poniżej", custom: "Własne wyrażenie",
  range_breakout: "Wybicie z konsolidacji", volume_spike: "Skok wolumenu",
};
const DIR_WORD: Record<string, string> = { up: "w górę", down: "w dół", any: "w którąkolwiek stronę" };

/** Condition in words for the alert table: "cena poniżej poziomu", "zmiana w oknie", "waga koszyka powyżej". */
export function alertConditionText(a: Pick<AlertLike, "kind" | "scope" | "params">): string {
  const p = a.params;
  switch (a.kind) {
    case "price_below": return "cena poniżej poziomu";
    case "price_above": return "cena powyżej poziomu";
    case "change_pct": return `zmiana w oknie ${n(p.window_days) ?? "-"} sesji`;
    case "drawdown_from_high": return `spadek od szczytu ${win(n(p.window_days) ?? 252)}`;
    case "new_high": return `nowy szczyt ${win(n(p.window_days) ?? 252)}`;
    case "sma_cross": return `przecięcie średniej ${n(p.window_days) ?? 200}-dniowej ${p.direction === "above" ? "w górę" : "w dół"}`;
    case "weight_above": return a.scope === "bucket" ? "waga koszyka powyżej" : "waga powyżej";
    case "weight_below": return a.scope === "bucket" ? "waga koszyka poniżej" : "waga poniżej";
    case "range_breakout": return `wybicie z zakresu ${n(p.window_days) ?? 30} sesji (zakres do ${pctTarget(n(p.max_range_pct) ?? 0.08)})`;
    case "volume_spike": return `wolumen ${ratioX(n(p.multiple) ?? 2.5)} średniej z ${n(p.window_days) ?? 20} sesji`;
    case "custom": return `wyrażenie: ${s(p.expression) ? unnameBuckets(s(p.expression)!) : "-"}`;
    default: return a.kind;
  }
}

/** The level an alert waits for, formatted ("140,00 zł", "-10 %", "4 %"), or null. */
export function alertLevelText(a: AlertLike): string | null {
  const p = a.params, c = a.instrument?.currency;
  switch (a.kind) {
    case "price_below": case "price_above": return price(n(p.level), c);
    case "change_pct": return `${p.direction === "down" ? "-" : p.direction === "up" ? "+" : "±"}${pctTarget(n(p.threshold))}`;
    case "drawdown_from_high": return `-${pctTarget(n(p.threshold))}`;
    case "weight_above": case "weight_below": return pctTarget(n(p.threshold));
    case "range_breakout": {
      const lo = n(a.state?.range_low), hi = n(a.state?.range_high);
      return lo != null && hi != null ? `zakres ${price(lo, c)}-${price(hi, c)}` : null;
    }
    case "volume_spike": return ratioX(n(p.multiple));
    default: return null;
  }
}

/** The measured value now ("148,60 zł", "-12,4 %", "5,3 %"), or null. */
export function alertNowText(a: AlertLike): string | null {
  const v = a.last_value, c = a.instrument?.currency;
  if (v == null) return null;
  switch (a.kind) {
    case "price_below": case "price_above": case "new_high": case "sma_cross": case "range_breakout": return price(v, c);
    case "volume_spike": return ratioX(v);
    case "change_pct": return pct(v, true);
    case "drawdown_from_high": return pct(-v);
    case "weight_above": case "weight_below": return pct(v);
    default: return null;
  }
}

/** Distance to the level and the closeness bar fill (0..1): percent of the price for price levels,
 * percentage points for weights, change and drawdown. Null when the alert has no measurable distance. */
export function alertDistance(a: AlertLike): { text: string; fill: number; pp: boolean; level?: string } | null {
  const v = a.last_value, p = a.params;
  if (v == null) return null;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  switch (a.kind) {
    case "price_below":
    case "price_above": {
      const level = n(p.level);
      if (level == null || v <= 0) return null;
      const d = Math.abs(v - level) / v;
      return { text: pct(d), fill: clamp(1 - d / 0.2), pp: false };
    }
    case "weight_above":
    case "weight_below": {
      const t = n(p.threshold);
      if (t == null) return null;
      const d = Math.abs(v - t) * 100;
      return { text: pp(d).replace(/^\+/, ""), fill: clamp(1 - d / 3.3), pp: true };
    }
    case "drawdown_from_high": {
      const t = n(p.threshold);
      if (t == null) return null;
      const d = Math.max(0, t - v) * 100;
      return { text: pp(d).replace(/^\+/, ""), fill: clamp(1 - d / 10), pp: true };
    }
    case "change_pct": {
      const t = n(p.threshold);
      if (t == null) return null;
      const moved = p.direction === "up" ? v : p.direction === "down" ? -v : Math.abs(v);
      const d = Math.max(0, t - moved) * 100;
      return { text: pp(d).replace(/^\+/, ""), fill: clamp(1 - d / 10), pp: true };
    }
    case "range_breakout": {
      // The distance of the close to the edge the alert waits for (the server echoes the range in `state`).
      const b = breakoutEdge(a, v);
      if (!b) return null;
      return { text: pct(b.d), fill: clamp(1 - b.d / 0.2), pp: false, level: price(b.edge, a.instrument?.currency) };
    }
    case "volume_spike": {
      const m = n(p.multiple);
      if (m == null || m <= 0) return null;
      return { text: ratioX(Math.max(0, m - v)), fill: clamp(v / m), pp: false };
    }
    default:
      return null;
  }
}

/** Default title from the condition ("CDR poniżej 140,00 zł", "KGHM -10 % w 30 sesji"). */
export function alertDefaultTitle(kind: string, params: Record<string, unknown>, subject: string, currency?: string | null): string {
  const p = params;
  const who = subject || "Portfel";
  switch (kind) {
    case "price_below": return `${who} poniżej ${price(n(p.level), currency)}`;
    case "price_above": return `${who} powyżej ${price(n(p.level), currency)}`;
    case "change_pct": return `${who} ${p.direction === "up" ? "+" : p.direction === "down" ? "-" : "±"}${pctTarget(n(p.threshold))} w ${n(p.window_days) ?? "-"} sesji`;
    case "drawdown_from_high": return `${who}: spadek ${pctTarget(n(p.threshold))} od szczytu`;
    case "new_high": return `${who}: nowy szczyt ${win(n(p.window_days) ?? 252)}`;
    case "sma_cross": return `${who}: SMA ${n(p.window_days) ?? 200} ${p.direction === "above" ? "w górę" : "w dół"}`;
    case "weight_above": return `${who} powyżej ${pctTarget(n(p.threshold))}`;
    case "weight_below": return `${who} poniżej ${pctTarget(n(p.threshold))}`;
    case "range_breakout": return `${who}: wybicie z konsolidacji ${n(p.window_days) ?? 30} sesji`;
    case "volume_spike": return `${who}: wolumen ${ratioX(n(p.multiple) ?? 2.5)} średniej`;
    default: return `${who}: warunek własny`;
  }
}

/** The form's preview: exactly when it fires and what happens then (copy of the alerts mock). */
export function alertPreview(args: {
  kind: string; params: Record<string, unknown>; subject: string; currency?: string | null; now?: number | null;
  polarity: string; severity: string; cooldown: number | null; digestWeekday?: string;
}): string {
  const { kind, params: p, subject, currency } = args;
  const who = subject || "portfela";
  let when: string;
  switch (kind) {
    case "price_below": when = `cena ${who} spadnie poniżej ${price(n(p.level), currency)}${args.now != null ? ` (teraz ${price(args.now, currency)})` : ""}`; break;
    case "price_above": when = `cena ${who} wzrośnie powyżej ${price(n(p.level), currency)}${args.now != null ? ` (teraz ${price(args.now, currency)})` : ""}`; break;
    case "change_pct": when = `kurs ${who} ${p.direction === "up" ? "wzrośnie" : p.direction === "down" ? "spadnie" : "zmieni się"} o co najmniej ${pctTarget(n(p.threshold))} w ${n(p.window_days) ?? "-"} sesjach`; break;
    case "drawdown_from_high": when = `${who} będzie ${pctTarget(n(p.threshold))} poniżej szczytu z ${win(n(p.window_days) ?? 252)}`; break;
    case "new_high": when = `${who} zamknie się na nowym szczycie z ${win(n(p.window_days) ?? 252)}`; break;
    case "sma_cross": when = `cena ${who} przetnie średnią ${n(p.window_days) ?? 200}-dniową ${p.direction === "above" ? "w górę" : "w dół"}`; break;
    case "weight_above": when = `udział ${who} w portfelu przekroczy ${pctTarget(n(p.threshold))}`; break;
    case "weight_below": when = `udział ${who} w portfelu spadnie poniżej ${pctTarget(n(p.threshold))}`; break;
    case "range_breakout":
      return `Zadziała, gdy kurs ${who} wyjdzie ${DIR_WORD[String(p.direction ?? "any")] ?? DIR_WORD.any} poza zakres ostatnich ${n(p.window_days) ?? 30} sesji, o ile ten zakres był węższy niż ${pctTarget(n(p.max_range_pct) ?? 0.08)}.${tailOf(args)}`;
    case "volume_spike":
      return `Zadziała, gdy wolumen ${who} przekroczy ${ratioX(n(p.multiple) ?? 2.5)} średnią z ${n(p.window_days) ?? 20} sesji.${tailOf(args)}`;
    default: when = `wyrażenie będzie prawdziwe dla ${who}`;
  }
  return `Zadziała, gdy ${when}.${tailOf(args)}`;
}

/** The preview's second sentence: notification, the signal's column, the pause. */
function tailOf(args: { polarity: string; severity: string; cooldown: number | null }): string {
  const notify = args.severity === "action" ? "Powiadomienie od razu" : `Bez powiadomienia, w podsumowaniu tygodnia`;
  const column = args.polarity === "positive" ? "„Szanse\"" : args.polarity === "negative" ? "„Ryzyka i przegląd\"" : "„Ryzyka i przegląd\" (neutralny)";
  const pause = args.cooldown ? `, pauza ${plural(args.cooldown, "dzień", "dni", "dni")} po spełnieniu` : "";
  return ` ${notify}, sygnał w ${column}${pause}.`;
}

/** "wygasa 31.12" / "do 1.11" suffix of an alert condition line. */
export function alertWhenSuffix(a: Pick<AlertLike, "status" | "expires_at" | "snoozed_until">): string | null {
  if (a.status === "snoozed" && a.snoozed_until) return `uśpiony do ${dm(a.snoozed_until)}`;
  if (a.expires_at) return `wygasa ${dm(a.expires_at)}`;
  return null;
}

/** Status order of the alerts widget: triggered first, then active, snoozed, muted, expired. */
export function orderAlerts<T extends { status: string; id: number }>(list: T[]): T[] {
  const r: Record<string, number> = { triggered: 0, active: 1, snoozed: 2, muted: 3, expired: 4 };
  return [...list].sort((a, b) => (r[a.status] ?? 9) - (r[b.status] ?? 9) || b.id - a.id);
}

// ---- alert state (home v3, Q3 / Q5 / Q11: home-v3.md 9.2) ---------------------------------------------------

export type AlertState = "far" | "near" | "met";
/** "Close to the level": within this percent of the price (price kinds, range edges) or these percentage points
 * (weight, change, drawdown); strategy `alerts.near_price_pct` / `alerts.near_pp` override when the server sends them. */
export const NEAR_PRICE_PCT = 5, NEAR_PP = 2;

/** The range edge a `range_breakout` alert waits for (`up` the high, `down` the low, `any` the nearer one) and
 * the close's distance to it as a fraction; null while the range is wider than `max_range_pct` (the alert
 * cannot fire until it narrows) or the server sent no range (F8 review FE-6). */
export function breakoutEdge(a: Pick<AlertLike, "params" | "state">, close: number): { edge: number; d: number } | null {
  const lo = n(a.state?.range_low), hi = n(a.state?.range_high);
  if (lo == null || hi == null || lo <= 0 || close <= 0) return null;
  const width = n(a.state?.range_pct) ?? (hi - lo) / lo;
  if (width > (n(a.params.max_range_pct) ?? 0.08) + 1e-9) return null;
  const toHi = Math.max(0, hi - close) / close, toLo = Math.max(0, close - lo) / close;
  const dir = a.params.direction;
  if (dir === "up") return { edge: hi, d: toHi };
  if (dir === "down") return { edge: lo, d: toLo };
  return toHi <= toLo ? { edge: hi, d: toHi } : { edge: lo, d: toLo };
}

/** The gap to the level as a number: percent of the price, percentage points or the volume ratio's share of the
 * multiple; null for kinds without a distance (sma_cross, new_high, custom) or without the data. */
function alertGap(a: AlertLike): { kind: "pct" | "pp" | "ratio"; value: number; limit?: number } | null {
  const v = a.last_value, p = a.params;
  if (v == null) return null;
  switch (a.kind) {
    case "price_below": case "price_above": {
      const level = n(p.level);
      return level == null || v <= 0 ? null : { kind: "pct", value: (Math.abs(v - level) / v) * 100 };
    }
    case "range_breakout": {
      // Near only in the last quarter of the allowed range (a close inside a narrow range is always a few
      // percent from an edge, F8 review FE-6).
      const b = breakoutEdge(a, v);
      return b ? { kind: "pct", value: b.d * 100, limit: (n(p.max_range_pct) ?? 0.08) * 25 } : null;
    }
    case "weight_above": case "weight_below": {
      const t = n(p.threshold);
      return t == null ? null : { kind: "pp", value: Math.abs(v - t) * 100 };
    }
    case "drawdown_from_high": {
      const t = n(p.threshold);
      return t == null ? null : { kind: "pp", value: Math.max(0, t - v) * 100 };
    }
    case "change_pct": {
      const t = n(p.threshold);
      if (t == null) return null;
      const moved = p.direction === "up" ? v : p.direction === "down" ? -v : Math.abs(v);
      return { kind: "pp", value: Math.max(0, t - moved) * 100 };
    }
    case "volume_spike": {
      const m = n(p.multiple);
      return m == null || m <= 0 ? null : { kind: "ratio", value: v / m };
    }
    default: return null;
  }
}

/** met = status triggered (its signal is open); near = within the thresholds (volume: ratio >= 0.7 x the
 * multiple); else far. Kinds without a distance are far until met. */
export function alertState(a: AlertLike, near?: { pricePct?: number | null; pp?: number | null } | null): AlertState {
  if (a.status === "triggered") return "met";
  const g = alertGap(a);
  if (!g) return "far";
  const lim = g.limit ?? (g.kind === "pct" ? near?.pricePct ?? NEAR_PRICE_PCT : near?.pp ?? NEAR_PP);
  return (g.kind === "ratio" ? g.value >= 0.7 : g.value <= lim + 1e-9) ? "near" : "far";
}

/** The condition in a few words (the met fact and the waiting fallback): `poniżej 75,00 zł`, `-10 % w 30 sesji`. */
function alertCondShort(a: AlertLike): string {
  const p = a.params, c = a.instrument?.currency;
  switch (a.kind) {
    case "price_below": return `poniżej ${price(n(p.level), c)}`;
    case "price_above": return `powyżej ${price(n(p.level), c)}`;
    case "change_pct": return `${p.direction === "up" ? "+" : p.direction === "down" ? "-" : "±"}${pctTarget(n(p.threshold))} w ${n(p.window_days) ?? "-"} sesji`;
    case "drawdown_from_high": return `spadek ${pctTarget(n(p.threshold))} od szczytu`;
    case "new_high": return `${p.direction === "low" ? "nowy dołek" : "nowy szczyt"} ${win(n(p.window_days) ?? 252)}`;
    case "sma_cross": return `${p.direction === "above" ? "nad" : "pod"} SMA ${n(p.window_days) ?? 200}`;
    case "weight_above": return `powyżej ${pctTarget(n(p.threshold))}`;
    case "weight_below": return `poniżej ${pctTarget(n(p.threshold))}`;
    case "range_breakout": return `wybicie z konsolidacji ${n(p.window_days) ?? 30} sesji`;
    case "volume_spike": return `wolumen ${ratioX(n(p.multiple) ?? 2.5)} średniej`;
    default: return unnameBuckets(a.title);
  }
}

/** The icon's tooltip, never a state word: waiting `5,8 % do 140,00 zł · teraz 148,60 zł`; met `poniżej 140,00 zł
 * od 2.10`; no distance `teraz 486,10 zł`. */
export function alertFact(a: AlertLike): string {
  if (a.status === "triggered") return `${alertCondShort(a)}${a.last_triggered_at ? ` od ${dm(a.last_triggered_at)}` : ""}`;
  const d = alertDistance(a), level = d?.level ?? alertLevelText(a), now = alertNowText(a);
  if (d && level) return `${d.text} do ${level}${now ? ` · teraz ${now}` : ""}`;
  return now ? `teraz ${now}` : alertCondShort(a);
}

const LIVE = (a: { status: string }) => a.status === "active" || a.status === "triggered";
/** An instrument's alerts state: met > near > far over its live alerts; null without any. */
export function alertStateOf(alerts: AlertLike[], near?: { pricePct?: number | null; pp?: number | null } | null): AlertState | null {
  const st = alerts.filter(LIVE).map((a) => alertState(a, near));
  return st.includes("met") ? "met" : st.includes("near") ? "near" : st.length ? "far" : null;
}

/** The nearest live alert (the bell's tooltip): a met one first, else the closest to its level, else the newest. */
export function nearestAlert<T extends AlertLike & { id: number }>(alerts: T[]): T | null {
  const live = alerts.filter(LIVE);
  return [...live].sort((a, b) => Number(b.status === "triggered") - Number(a.status === "triggered")
    || (alertDistance(b)?.fill ?? -1) - (alertDistance(a)?.fill ?? -1) || b.id - a.id)[0] ?? null;
}

/** The home's Alerty widget (Q5): waiting alerts only (`active`), nearest to the level first, no distance last,
 * then the newest. */
export function waitingAlerts<T extends AlertLike & { id: number }>(list: T[]): T[] {
  return list.filter((a) => a.status === "active").sort((a, b) => {
    const da = alertDistance(a)?.fill, db = alertDistance(b)?.fill;
    return (da == null ? 1 : 0) - (db == null ? 1 : 0) || (db ?? 0) - (da ?? 0) || b.id - a.id;
  });
}

// ---- table rows: flags and markers (Q4 / Q10 / Q14) ------------------------------------------------------

/** One instrument's markers in Aktywa / Obserwowane: the state glyph of its open signals (one `mixed` glyph for a
 * good and a bad one), the nearest live alert (the bell) and the unread research notes (the page glyph). */
export function rowFlags<S extends SigLike, A extends AlertLike & { id: number; instrument_id?: number | null }>(
  instrumentId: number | string, signals: S[], alerts: A[], unread: number,
): { state: SigState | null; alert: A | null; notes: number } {
  const id = String(instrumentId);
  const open = signals.filter((x) => String(x.instrument_id) === id && !settled(x));
  return { state: stateOf([...new Set(open.map((x) => polarityOf(x)))]), alert: nearestAlert(alerts.filter((a) => String(a.instrument_id) === id)), notes: Math.max(0, unread) };
}

// ---- prices ------------------------------------------------------------------------------------------

/** Change over the last week from daily closes: last close vs the newest close at least 7 days older. */
export function weekChange(closes: { date: string; close: number }[] | null | undefined): number | null {
  if (!closes || closes.length < 2) return null;
  const last = closes[closes.length - 1];
  const t = Date.parse(`${last.date}T12:00:00`) - 7 * 86400000;
  for (let i = closes.length - 2; i >= 0; i--) {
    if (Date.parse(`${closes[i].date}T12:00:00`) <= t) return closes[i].close > 0 ? last.close / closes[i].close - 1 : null;
  }
  return null;
}

/** The move shown on a watchlist row: the week from 30-day closes, else the last session labelled "1 d."
 * (never a daily move under "tydz.", F7 FE8). */
export function watchMove(closes: { date: string; close: number }[] | null | undefined, change1d: number | null | undefined): { value: number; label: string } | null {
  const wk = weekChange(closes);
  if (wk != null) return { value: wk, label: "tydz." };
  return change1d != null && Number.isFinite(change1d) ? { value: change1d, label: "1 d." } : null;
}

// ---- re-entry and change log ---------------------------------------------------------------------------

export const REENTRY_DAYS = 21;

/** Whole days between two instants (local calendar days). */
export function daysSince(fromIso: string, toIso: string): number {
  const a = serverDate(fromIso) ?? new Date(NaN), b = serverDate(toIso) ?? new Date(NaN);
  const da = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()), db = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / 86400000);
}

/** The re-entry baseline (F7 FE17): a pending baseline (kept in localStorage until "Wszystko jasne") wins;
 * else the last visit when it is at least REENTRY_DAYS old, which becomes pending (`store`). `advance` says
 * whether leaving the page may move the last-visit mark to now: never while a baseline is pending, so closing
 * the window or switching tabs before "Wszystko jasne" keeps the catch-up view for the next window. */
export function reentryBaseline(pending: string | null, lastSeen: string | null, now: string): { baseline: string | null; store: boolean; advance: boolean } {
  if (pending) return { baseline: pending, store: false, advance: false };
  if (lastSeen && daysSince(lastSeen, now) >= REENTRY_DAYS) return { baseline: lastSeen, store: true, advance: false };
  return { baseline: null, store: false, advance: true };
}

/** "Wracasz po 11 tygodniach" / "po 4 miesiącach" / "po 25 dniach" (locative plural). */
export function gapText(days: number): string {
  if (days >= 91) return `Wracasz po ${Math.round(days / 30.4)} miesiącach`;
  if (days >= 14) return `Wracasz po ${Math.round(days / 7)} tygodniach`;
  return days === 1 ? "Wracasz po dniu" : `Wracasz po ${days} dniach`;
}

export interface EventLike { type: string; at: string; date: string; polarity?: string }

const IMPORTANT = new Set(["signal_created", "alert_triggered", "signal_escalated", "import", "proposal", "deposit", "withdrawal"]);
export const isImportant = (e: EventLike) => IMPORTANT.has(e.type);

const MONTHS = ["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec", "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień"];

/** Events newest first, grouped by calendar month ("Październik"; the year is added when it is not the
 * year of `today`). */
export function groupByMonth<T extends EventLike>(events: T[], today: string): { key: string; label: string; items: T[] }[] {
  const year = Number(today.slice(0, 4));
  const sorted = [...events].sort((a, b) => b.at.localeCompare(a.at));
  const out: { key: string; label: string; items: T[] }[] = [];
  for (const e of sorted) {
    const key = e.date.slice(0, 7);
    let g = out[out.length - 1];
    if (!g || g.key !== key) {
      const [y, m] = key.split("-").map(Number);
      g = { key, label: `${MONTHS[m - 1] ?? key}${y !== year ? ` ${y}` : ""}`, items: [] };
      out.push(g);
    }
    g.items.push(e);
  }
  return out;
}

/** Key of the signal state a decision / acknowledge / snooze changes (F7 fix pass F1, inflight.ts `stillLocked`). */
export function signalStateKey(s: { status?: string; decisions?: { id: number }[]; snoozed?: boolean; snoozed_until?: string | null }): string {
  return [s.status ?? "", (s.decisions ?? []).map((d) => d.id).join(","), s.snoozed ? s.snoozed_until ?? "1" : ""].join("|");
}

// ---- performance ---------------------------------------------------------------------------------------

export interface PointLike { date: string; value: number | null; twr: number | null; benchmark: number | null; simulated_value: number | null; flow: number | null; drawdown: number | null }

/** Change from the newest point on/before `since` to the last point: TWR ratio (contributions-neutral),
 * the market change in money (value change minus the deposits / withdrawals in between, F7 FE6, as the
 * hero's week move), and the benchmark's change over the same days. */
export function changeSince(points: PointLike[], since: string): { pct: number | null; money: number | null; bench: number | null; from: string | null } {
  if (points.length < 2) return { pct: null, money: null, bench: null, from: null };
  let k = 0;
  for (let i = 0; i < points.length; i++) if (points[i].date <= since) k = i;
  const a = points[k], b = points[points.length - 1];
  const ratio = (x: number | null, y: number | null) => (x == null || y == null || 1 + x === 0 ? null : (1 + y) / (1 + x) - 1);
  const flows = points.slice(k + 1).reduce((acc, p) => acc + (p.flow ?? 0), 0);
  return {
    pct: ratio(a.twr, b.twr),
    money: a.value != null && b.value != null ? b.value - a.value - flows : null,
    bench: ratio(a.benchmark, b.benchmark),
    from: a.date,
  };
}

/** Value line of the review digest ("Co się zmieniło"), F7 F2. `market_change` absent (older server):
 * fall back to `change` as before. `market_change: null` while `change` is set means the backend could not
 * value the transfers: the line shows the value change labelled as such (no TWR %, no "bez wpłat", which
 * would claim the deposits were taken out) and the transfers row says they are not valued. */
export interface DigestValueLike {
  then: number | null; change: number | null; change_pct: number | null;
  contributions?: number | null; market_change?: number | null; market_change_pct?: number | null; transfers?: number | null;
}
export function digestValueLine(v: DigestValueLike, sincePct: number | null): {
  kind: "market" | "value" | "none"; amount: number | null; pct: number | null; contributions: number | null; transfersUnvalued: boolean;
} {
  const transfersUnvalued = "transfers" in v && v.transfers === null && v.then != null;
  const pctOf = () => v.market_change_pct ?? sincePct ?? v.change_pct;
  if (v.market_change != null) return { kind: "market", amount: v.market_change, pct: pctOf(), contributions: v.contributions ?? null, transfersUnvalued };
  if (v.market_change === undefined && v.change != null) return { kind: "market", amount: v.change, pct: pctOf(), contributions: v.contributions ?? null, transfersUnvalued };
  if (v.change != null) return { kind: "value", amount: v.change, pct: null, contributions: null, transfersUnvalued };
  return { kind: "none", amount: null, pct: null, contributions: null, transfersUnvalued };
}

// ---- surplus -> contribution (Przegląd card, F7 FE5) -------------------------------------------------------

/** Months of this year the monthly plan counts: from January, or from the month of the first deposit when
 * that falls in this year (a profile that started in July has no missed months before it). Shared by the
 * Wpłaty widget and the surplus card. */
export function planMonthsSoFar(firstDeposit: string | null, today: string): number {
  const fromMonth = firstDeposit && firstDeposit.slice(0, 4) === today.slice(0, 4) ? Number(firstDeposit.slice(5, 7)) : 1;
  return Math.max(1, Number(today.slice(5, 7)) - fromMonth + 1);
}

/** Percentage points a contribution adds to a bucket at weight `w` (fraction) of a portfolio worth `total`:
 * (w * T + a) / (T + a) - w = a * (1 - w) / (T + a). */
export function contributionPp(amount: number, total: number, weight: number): number {
  if (!(amount > 0) || !(total + amount > 0)) return 0;
  return (amount * (1 - Math.min(1, Math.max(0, weight)))) / (total + amount) * 100;
}

/** The contribution facts of this year (hero `Wpłaty`, the Wpłaty widget of the light grid): deposits so far,
 * the plan so far (from January or from the first deposit of this year) and the months of that span without a
 * deposit (the current month counts only once it has one). */
export function contributionFacts(a: {
  months: { value: number }[]; deposits: number | null; plan: { amount: number } | null; firstDeposit: string | null; today: string;
}): { deposits: number | null; planYtd: number | null; missed: number } {
  const monthsSoFar = planMonthsSoFar(a.firstDeposit, a.today);
  const curDone = (a.months[a.months.length - 1]?.value ?? 0) > 0;
  const planYtd = a.plan ? a.plan.amount * monthsSoFar : null;
  const missed = a.plan ? a.months.slice(-monthsSoFar, curDone ? undefined : -1).filter((m) => m.value <= 0).length : 0;
  return { deposits: a.deposits, planYtd, missed };
}

/** An account's snapshot cell in the Alokacja `Rachunki` view: the date (or `brak`), the row's tooltip and the
 * warn flag (a snapshot older than 14 days while an import exists: `uzgodnij`). */
export function accountSnapshot(a: { snapshot_date?: string | null; last_import?: { at: string } | null }, today: string): { cell: string; title: string; warn: boolean } {
  const imp = a.last_import ? `import ${dm(a.last_import.at)}` : "bez importu";
  if (!a.snapshot_date) return { cell: "brak", title: `bez snapshotu · ${imp}`, warn: false };
  const age = Math.round((Date.parse(today) - Date.parse(a.snapshot_date)) / 86400000);
  const warn = age > 14 && !!a.last_import;
  return { cell: dm(a.snapshot_date), title: `snapshot ${dm(a.snapshot_date)} · ${imp}${warn ? " · starszy niż 14 dni" : ""}`, warn };
}

/** The card's flow from the month close of one currency: what is left for investing after the cushion top-up
 * (`suggested_transfer`, the budget card's "Na inwestycje"), what stays or is missing against the planned
 * contribution, and the primary button amount = min(plan, available) (none when nothing is available). */
export function surplusFlow(close: { surplus: number; cushion_top_up: number; suggested_transfer: number }, want: number | null) {
  const available = Math.max(0, close.suggested_transfer);
  const stays = want != null ? available - want : null;
  const primary = want != null && want > 0 && available > 0 ? Math.min(want, available) : null;
  return { available, topUp: close.cushion_top_up, stays, primary };
}

/** Deposits per calendar month (positive flows) for the last `months` months ending at `today`'s month. */
export function monthlyFlows(points: { date: string; flow: number | null }[], today: string, months = 12): { key: string; label: string; value: number }[] {
  const short = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];
  const [y, m] = today.split("-").map(Number);
  const out: { key: string; label: string; value: number }[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(y, m - 1 - i, 1);
    out.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: short[d.getMonth()], value: 0 });
  }
  const at = new Map(out.map((o, i) => [o.key, i]));
  for (const p of points) {
    const i = at.get(p.date.slice(0, 7));
    if (i != null && p.flow != null && p.flow > 0) out[i].value += p.flow;
  }
  return out;
}

/** Next digest weekday after `today` (the review's "następny 11.10"). */
export function nextWeekday(today: string, weekday: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const t = new Date(y, m - 1, d);
  const add = ((WEEKDAY_INDEX[weekday] ?? 0) - t.getDay() + 7) % 7 || 7;
  const r = new Date(y, m - 1, d + add);
  return `${r.getFullYear()}-${String(r.getMonth() + 1).padStart(2, "0")}-${String(r.getDate()).padStart(2, "0")}`;
}

/** Is today the digest weekday? */
export function isDigestDay(today: string, weekday: string): boolean {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(y, m - 1, d).getDay() === (WEEKDAY_INDEX[weekday] ?? 0);
}

/** decisions.md 7: the review strip opens by itself on the digest weekday while the review is due, unless
 * the owner opened or closed it in this visit (`explicit` = the session flag "1" / "0") or the profile is
 * light (zero start: the review button never turns primary) or has no data yet. */
export function reviewAutoOpen(a: { due: boolean; light: boolean; hasData: boolean; today: string; weekday: string; explicit: string | null }): boolean {
  return a.due && !a.light && a.hasData && a.explicit == null && isDigestDay(a.today, a.weekday);
}

/** The planned deposit of a month ("YYYY-MM") for the surplus card and the minimal view: a `planned` one
 * first (the newest), else a `booked` one (the import confirmed it); cancelled ones never count. */
export function planForMonth<T extends { id: number; planned_date: string; status: string }>(list: T[] | null | undefined, month: string): T | null {
  const inMonth = (list ?? []).filter((p) => p.planned_date.slice(0, 7) === month && p.status !== "cancelled");
  const pick = (st: string) => inMonth.filter((p) => p.status === st).sort((a, b) => b.id - a.id)[0] ?? null;
  return pick("planned") ?? pick("booked");
}

// ---- decision journal (route `journal`) -----------------------------------------------------------------

export type JournalFilter = "all" | "decisions" | "signals";
export interface JournalEntry<S, D> { at: string; type: "decision" | "signal" | "expired" | "resolved"; signal: S | null; decision: D | null }

/** The journal's timeline, newest first: decisions (with the signal they answer), signals as they appeared,
 * signals that expired without a decision and the ones resolved by the rules. `instrument` narrows to one
 * instrument (string id from the URL). */
export function journalEntries<
  S extends { id: number; instrument_id: number | null; status: string; first_seen_at: string | null; closed_at?: string | null; decisions: unknown[] },
  D extends { id: number; signal_id: number | null; instrument_id: number | null; created_at: string | null },
>(signals: S[], decisions: D[], filter: JournalFilter, instrument: string | null = null): JournalEntry<S, D>[] {
  const mine = <T extends { instrument_id: number | null }>(x: T) => instrument == null || String(x.instrument_id) === instrument;
  const byId = new Map(signals.map((s) => [s.id, s]));
  const out: JournalEntry<S, D>[] = [];
  if (filter !== "signals") {
    for (const d of decisions) {
      if (!d.created_at) continue;
      const sig = d.signal_id != null ? byId.get(d.signal_id) ?? null : null;
      if (instrument != null && !(mine(d) || (sig && mine(sig)))) continue;
      out.push({ at: d.created_at, type: "decision", signal: sig, decision: d });
    }
  }
  if (filter !== "decisions") {
    for (const s of signals) {
      if (!mine(s)) continue;
      if (s.first_seen_at) out.push({ at: s.first_seen_at, type: "signal", signal: s, decision: null });
      if (s.closed_at && (s.status === "expired" || s.status === "resolved") && !s.decisions.length) {
        out.push({ at: s.closed_at, type: s.status === "expired" ? "expired" : "resolved", signal: s, decision: null });
      }
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Facts of the journal for one year: decisions by action, signals decided vs expired without a decision,
 * the median days from a signal to its first decision. */
export function journalStats<
  S extends { first_seen_at: string | null; closed_at?: string | null; status: string; decisions: { created_at: string | null }[] },
  D extends { action: string; created_at: string | null },
>(signals: S[], decisions: D[], year: string) {
  const inYear = (iso: string | null | undefined) => !!iso && (localDay(iso) ?? "").slice(0, 4) === year;
  const ds = decisions.filter((d) => inYear(d.created_at));
  const byAction: Record<string, number> = {};
  for (const d of ds) byAction[d.action] = (byAction[d.action] ?? 0) + 1;
  const seen = signals.filter((s) => inYear(s.first_seen_at));
  const decided = seen.filter((s) => s.decisions.length > 0);
  const expired = seen.filter((s) => s.status === "expired" && !s.decisions.length).length;
  const days = decided.map((s) => {
    const first = s.decisions.map((d) => d.created_at).filter(Boolean).sort()[0] as string | undefined;
    return first && s.first_seen_at ? Math.max(0, (parseServerTime(first) - parseServerTime(s.first_seen_at)) / 86400000) : null;
  }).filter((x): x is number => x != null).sort((a, b) => a - b);
  const median = days.length ? (days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2) : null;
  return { decisions: ds.length, byAction, signals: seen.length, decided: decided.length, expired, medianDays: median };
}

// ---- notification links (F6 NT: a click opens `#/{slug}/investments.portfolio/?signal=<id>`) --------------

export type SignalLink = { kind: "open"; id: number } | { kind: "asset"; id: number; instrumentId: number; status: string } | { kind: "journal"; id: number; status: string };

/** Where `?signal=<id>` leads: an open signal (in the Sygnały widget: scroll, highlight, decision one click
 * away), a closed one with an instrument (the asset drawer's timeline), a closed portfolio-wide one (the
 * journal). Anything else (not a positive integer, unknown, another profile's id) is null: just the home. */
export function signalLinkTarget<S extends { id: number; instrument_id: number | null; status: string }>(
  param: string | null | undefined, open: S[], all: S[],
): SignalLink | null {
  if (!param || !/^\d+$/.test(param)) return null;
  const id = Number(param);
  if (!(id > 0)) return null;
  if (open.some((s) => s.id === id)) return { kind: "open", id };
  const s = all.find((x) => x.id === id);
  if (!s) return null;
  if (s.status === "active" || s.status === "acknowledged") return { kind: "open", id };
  return s.instrument_id != null ? { kind: "asset", id, instrumentId: s.instrument_id, status: s.status } : { kind: "journal", id, status: s.status };
}

// ---- asset header (F7 FE6) -----------------------------------------------------------------------------------

/** The instrument's average cost over all its accounts: the quantity-weighted per-account average when every
 * account keeps cost in the same currency, else the total cost in the base currency over the quantity. */
export function averageCost(
  pos: { quantity: number; cost: number | null; accounts: { quantity: number; average_cost: number | null; cost_currency: string }[] },
  base: string,
): { value: number; currency: string } | null {
  const accs = pos.accounts.filter((a) => a.quantity > 0);
  const cur = accs[0]?.cost_currency;
  if (accs.length && accs.every((a) => a.average_cost != null && a.cost_currency === cur)) {
    const q = accs.reduce((s, a) => s + a.quantity, 0);
    if (q > 0) return { value: accs.reduce((s, a) => s + a.average_cost! * a.quantity, 0) / q, currency: cur! };
  }
  return pos.cost != null && pos.quantity > 0 ? { value: pos.cost / pos.quantity, currency: base } : null;
}

/** Display names of well-known benchmark ids (strategy `benchmark.id`, matched case-insensitively). */
const BENCHMARK_NAME: Record<string, string> = {
  msci_acwi: "MSCI ACWI", msci_world: "MSCI World", ftse_all_world: "FTSE All-World", sp500: "S&P 500", msci_em: "MSCI EM",
  wig20: "WIG20", wig: "WIG", stoxx600: "STOXX 600",
};

/** The benchmark's name in the UI (F7 GF7): a strategy id is never rendered raw. A well-known index id gets its
 * name, else the proxy instrument's display name when the payload carries one (`proxy_label`; today's server
 * sends none), else `benchmark`. */
export function benchmarkLabel(b: { id?: string | null; proxy_label?: string | null } | null | undefined): string {
  const known = b?.id ? BENCHMARK_NAME[b.id.trim().toLowerCase()] : undefined;
  return known ?? (b?.proxy_label?.trim() || "benchmark");
}

/** The benchmark figure next to the minimal hero's "od pierwszej wpłaty" (P/L over net contributions): the
 * benchmark bought with the same deposits (`simulation.pnl` over the same net contributions), so both are the
 * same measure; without a simulation the benchmark's TWR, labelled as such (F7 FE6). */
export function heroBenchmark(
  b: { status: string; id: string | null; twr: number | null; simulation: { pnl: number | null } | null; covers_range_end?: boolean | null } | null | undefined,
  netContributions: number | null | undefined,
): { value: number; label: string } | null {
  if (!b || b.status !== "ok" || b.covers_range_end === false) return null;
  const name = benchmarkLabel(b);
  if (b.simulation?.pnl != null && netContributions) return { value: b.simulation.pnl / netContributions, label: `${name}, te same wpłaty` };
  return b.twr != null ? { value: b.twr, label: `${name}, TWR` } : null;
}

/** A benchmark whose prices stop before the range end is not compared (F7 fix pass F4, backend R4 nulls the
 * comparison figures): a short label for the fact detail and the last priced day for its tooltip. */
export function staleBenchmark(
  b: { status: string; id?: string | null; covers_range_end?: boolean | null; last_priced?: string | null } | null | undefined,
): { label: string; title: string } | null {
  if (!b || b.status !== "ok" || b.covers_range_end !== false) return null;
  return { label: "benchmark nieaktualny", title: `${benchmarkLabel(b)}: ceny do ${b.last_priced ? dm(b.last_priced) : "-"}` };
}

// ---- performance caveats (F7 FE13) -------------------------------------------------------------------------

/** The caveats of a performance range in Polish (`data_quality.notes`), plus a stale benchmark tail flagged by
 * `covers_range_end === false` when the server sent no `benchmark_stale` note. */
export function perfNotes(perf: {
  data_quality?: { notes?: { code: string; params?: Record<string, unknown> | null; message: string }[] } | null;
  benchmark?: { status: string; covers_range_end?: boolean | null; last_priced?: string | null } | null;
} | null | undefined): string[] {
  if (!perf) return [];
  const notes = perf.data_quality?.notes ?? [];
  const out = notes.map((n) => describePerfNote(n)).filter(Boolean);
  const b = perf.benchmark;
  if (b?.status === "ok" && b.covers_range_end === false && !notes.some((n) => n.code === "benchmark_stale")) {
    out.push(describePerfNote({ code: "benchmark_stale", params: { last_date: b.last_priced ?? null }, message: "benchmark ends early" }));
  }
  return [...new Set(out)];
}

// ---- instrument identity (design/v2/instrument-label/instrument-label.md) ----------------------------------

export interface InstLike {
  id: number | string; label: string; name?: string | null; symbol?: string | null; mic?: string | null;
  isin?: string | null; asset_class?: string | null; region?: string | null; status?: string | null;
  valuation_mode?: string | null; needs_classification?: boolean | null;
}

const QUOTE_SUFFIX = /-(USD|USDT|USDC|EUR|PLN|GBP|CHF|JPY|BTC|ETH)$/;

/** The avatar's monogram: the ticker, uppercase, 2-5 characters (`CDR.WA` -> CDR, `BTC-USD` -> BTC, `EDO0535` ->
 * EDO, `GOOGL` -> GOOG; five only for all digits `00241` or a share class `BRK-B`); no symbol: the name's initials
 * (`Obligacje EDO` -> OE, `Lokata` -> LO); nothing: `?`. */
export function instMono(i: Pick<InstLike, "symbol" | "name" | "label">): string {
  let t = (i.symbol ?? "").trim().toUpperCase();
  if (t) {
    t = t.replace(/\.[A-Z]{1,4}$/, "").replace(QUOTE_SUFFIX, "");
    const bond = /^([A-Z]{3})\d{4}$/.exec(t);
    if (bond) return bond[1];
    if (/^\d+$/.test(t)) return t.slice(0, 5);
    if (/^[A-Z0-9]{1,3}-[A-Z]$/.test(t)) return t;
    if (t) return t.slice(0, 4);
  }
  const words = (i.name || i.label || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const mono = words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2);
  return mono.toUpperCase();
}

/** Instrument status words (never the backend's raw status). */
export const INST_STATUS: Record<string, string> = { frozen: "zamrożony", delisted: "wycofany z giełdy", inactive: "nieaktywny" };

/** The hover card's facts (Polish only): head = name + `symbol · exchange`, rows = klasa (+ region when known),
 * rachunek / rachunki (positions), ISIN; status tags only for what is not normal. No bucket (F7-generic). */
export function instCardFacts(i: InstLike, o: { accounts?: string[]; stale?: string | null } = {}): { head: [string, string]; rows: [string, string][]; status: string[] } {
  const cls = i.asset_class ? ASSET_CLASS[i.asset_class] ?? null : null;
  const reg = i.region && i.region.toLowerCase() !== "unknown" ? REGION[i.region.toLowerCase()] ?? null : null;
  const rows: [string, string][] = [];
  if (cls) rows.push(["klasa", reg ? `${cls} · ${reg}` : cls]);
  if (o.accounts?.length) rows.push([o.accounts.length > 1 ? "rachunki" : "rachunek", o.accounts.join(", ")]);
  if (i.isin) rows.push(["ISIN", i.isin]);
  const status: string[] = [];
  if (i.needs_classification) status.push("do sklasyfikowania");
  if (i.valuation_mode === "cost") status.push("koszt + odsetki");
  else if (i.valuation_mode === "manual") status.push("wycena ręczna");
  if (o.stale) status.push(`cena z ${dm(o.stale)}`);
  if (i.status && i.status !== "active") status.push(INST_STATUS[i.status] ?? "nieaktywny");
  return { head: [instName({ label: i.label, name: i.name, symbol: i.symbol }), [i.symbol, micName(i.mic)].filter(Boolean).join(" · ")], rows, status };
}

/** One-line summary (the label's `title` where there is no hover): `INTC · Nasdaq · akcje · USA · XTB · IKE`. */
export function instSummary(i: InstLike, o: { accounts?: string[]; stale?: string | null } = {}): string {
  const f = instCardFacts(i, o);
  return [f.head[1], ...f.rows.map((r) => r[1])].filter(Boolean).join(" · ");
}

/** The Aktywa row's second line: `koszt + odsetki` and / or the single account in `Per rachunek`. */
export function subLine(o: { cost: boolean; split: "total" | "account"; accounts: { account_id: number }[]; accLabel: (id: number) => string }): string | undefined {
  return [o.cost ? "koszt + odsetki" : null, o.split === "account" && o.accounts.length === 1 ? o.accLabel(o.accounts[0].account_id) : null].filter(Boolean).join(" · ") || undefined;
}

// ---- asset detail v3 (F9, design/v3/asset-detail/asset-detail.md 3 + 7) -------------------------------------

/** A signal fact as plain text (the `Fact1` rendering without the bold). */
export function factText(f: SigFact): string {
  return `${f.pre ? `${f.pre}${f.bold ? " " : ""}` : ""}${f.bold}${f.post ? (/^[,.]/.test(f.post) ? f.post : ` ${f.post}`) : ""}`.trim();
}

/** The asset's open rows (7.1): open signals without a decision and not snoozed, in the rail's order (newest
 * first, action before info). Acknowledged ones are timeline rows, snoozed ones show nowhere until back. */
export function openRows<T extends SigLike>(signals: T[]): T[] {
  return signals.filter((s) => (s.status === "active" || s.status === "acknowledged") && !isDecided(s) && !s.snoozed).sort(byTime);
}

/** The header's lot table (3): lots sorted by open date with the result in % of their cost; `multi` when the
 * lots sit in more than one account (the account label goes under the date). */
export function lotRows<L extends { account_id: number; open_date: string; quantity: number; unit_cost: number | null; result: number | null }>(
  lots: L[],
): { rows: (L & { resultPct: number | null })[]; multi: boolean } {
  const rows = [...lots].sort((a, b) => a.open_date.localeCompare(b.open_date)).map((l) => {
    const cost = l.quantity * (l.unit_cost ?? 0);
    return { ...l, resultPct: l.result != null && cost ? l.result / cost : null };
  });
  return { rows, multi: new Set(lots.map((l) => l.account_id)).size > 1 };
}

export type HeaderMetaItem =
  | { kind: "lots"; text: string; toggle: boolean }
  | { kind: "txns"; text: string }
  | { kind: "dividends"; label: string; value: string }
  | { kind: "fees"; label: string; value: string };

/** The header's meta line (3) as data: `2 loty` (a toggle from two lots up; `1 lot` plain; `brak lotów`),
 * `4 transakcje` (`transakcje` while the detail loads), dividends per currency, fees. */
export function headerMeta(o: { lots: number; txns: number | null; dividends: Record<string, number>; fees: number; currency: string }): HeaderMetaItem[] {
  const divs = Object.entries(o.dividends).filter(([, v]) => v);
  return [
    { kind: "lots", text: o.lots ? plural(o.lots, "lot", "loty", "lotów") : "brak lotów", toggle: o.lots > 1 },
    { kind: "txns", text: o.txns == null ? "transakcje" : plural(o.txns, "transakcja", "transakcje", "transakcji") },
    { kind: "dividends", label: "dywidendy", value: divs.length ? divs.map(([k, v]) => money(v, k)).join(", ") : money(0, o.currency) },
    { kind: "fees", label: "opłaty", value: money(o.fees, o.currency) },
  ];
}

/** One row of the asset's `Sygnały i decyzje` timeline: date · dot · one fact (+ the owner's reason as `sub`,
 * a muted `tail` word such as `wygasł`). */
export interface TlRow { at: string; dot: "pos" | "neg" | "nw" | "neu" | ""; head: string; fact: string; tail?: string; sub?: string; title?: string; key: string }

interface TlDecision { id: number; signal_id: number | null; signal_ids?: number[]; action: string; quantity: number | null; price: number | null; currency: string | null; reason: string | null; created_at: string | null }
interface TlSignal extends SigLike { closed_at?: string | null }

const isAck = (d: Pick<TlDecision, "action" | "reason">) => (d.action === "held" && d.reason === "acknowledged") || (d.reason ?? "").startsWith("decyzja: ");
const linkedIds = (d: Pick<TlDecision, "signal_id" | "signal_ids">) => [...new Set([...(d.signal_ids ?? []), ...(d.signal_id != null ? [d.signal_id] : [])])];
const STATE_HEAD: Record<Polarity, string> = { positive: "Szansa", negative: "Ryzyko", neutral: "Sygnał" };

/** The timeline (7.3), newest first, at most `limit`: decisions (`Decyzja · dokupuję 10 szt. @ 44,80 $`, the
 * reason as `sub`), acknowledgements (`Potwierdzone · <fact>`; fan-out ones of a decision's minute fold into it),
 * closed signals (`Ryzyko · <fact>` + `wygasł`), thesis reviews, buys and sells. Open signals never appear here
 * (undecided ones are the rows above it, decided ones are told by their decision); research notes neither. */
export function assetTimeline(o: {
  signals: TlSignal[];
  decisions: TlDecision[];
  theses: { reviewed_at: string | null }[];
  txns: { id: number | string; type: string; trade_date: string; quantity: number | null; price: number | null; currency: string }[];
  ctx?: { total?: number | null; base?: string; names?: Map<number, string> };
  currency: string;
}, limit = 12): TlRow[] {
  const byId = new Map(o.signals.map((x) => [x.id, x]));
  const factOf = (id: number) => { const x = byId.get(id); return x ? factText(signalFact(x)) : null; };
  const longOf = (x: SigLike) => { const t = signalText(x, o.ctx ?? {}); return [t.lead, t.bold, t.tail].filter(Boolean).join(" "); };
  const at = (iso: string | null) => parseServerTime(iso);
  const out: TlRow[] = [];
  const decisions = o.decisions.filter((d) => d.created_at);
  const real = decisions.filter((d) => !isAck(d));
  // The `decyzja: <tag>` tag a fan-out writes for a decision (decisionTag without the prefix).
  const tagOf = (d: TlDecision) => `${DECISION_ACTION[d.action] ?? d.action}${d.quantity != null && (d.action === "bought" || d.action === "sold") ? ` ${qty(d.quantity)} szt.` : ""}`;
  const folded = new Map<number, string[]>();
  for (const d of decisions) {
    if (!isAck(d)) continue;
    const ids = linkedIds(d);
    // A fan-out acknowledgement (`decyzja: <tag>`) written within 60 s of a decision is part of it: the nearest
    // decision with the same tag, else the nearest one.
    if ((d.reason ?? "").startsWith("decyzja: ")) {
      const t = at(d.created_at);
      const tag = (d.reason ?? "").slice("decyzja: ".length).replace(/\s+/g, " ").trim();
      const near = real.map((r) => ({ r, dt: Math.abs(at(r.created_at) - t) })).filter((x) => Number.isFinite(x.dt) && x.dt <= 60000)
        .sort((x, y) => Number(tagOf(y.r).replace(/\s+/g, " ") === tag) - Number(tagOf(x.r).replace(/\s+/g, " ") === tag) || x.dt - y.dt);
      const host = near[0]?.r;
      if (host) { folded.set(host.id, [...(folded.get(host.id) ?? []), ...ids.map(factOf).filter((x): x is string => !!x)]); continue; }
    }
    const fact = ids.map(factOf).find(Boolean) ?? "";
    out.push({ at: d.created_at!, dot: "neu", head: "Potwierdzone", fact, key: `a:${d.id}` });
  }
  for (const d of real) {
    const trade = (d.action === "bought" || d.action === "sold") && d.quantity != null;
    const fact = `${DECISION_ACTION[d.action] ?? d.action}${trade ? ` ${qty(d.quantity)} szt.${d.price != null ? ` @ ${money(d.price, d.currency ?? o.currency)}` : ""}` : ""}`;
    const reason = d.reason && d.reason !== "acknowledged" && !d.reason.startsWith("decyzja: ") ? d.reason : null;
    const facts = [...linkedIds(d).map(factOf).filter((x): x is string => !!x), ...(folded.get(d.id) ?? [])];
    const title = [reason, ...new Set(facts)].filter(Boolean).join("\n") || undefined;
    out.push({ at: d.created_at!, dot: "nw", head: "Decyzja", fact, ...(reason ? { sub: reason } : {}), ...(title ? { title } : {}), key: `d:${d.id}` });
  }
  for (const x of o.signals) {
    if (x.status !== "resolved" && x.status !== "expired") continue;
    const at = x.first_seen_at ?? x.closed_at ?? null;
    if (!at) continue;
    out.push({ at, dot: "neu", head: STATE_HEAD[polarityOf(x)], fact: factText(signalFact(x)), ...(x.status === "expired" ? { tail: "wygasł" } : {}), title: longOf(x), key: `s:${x.id}` });
  }
  for (const r of new Set(o.theses.map((t) => t.reviewed_at).filter((v): v is string => !!v))) {
    out.push({ at: r, dot: "", head: "Przegląd tezy", fact: "", key: `r:${r}` });
  }
  for (const t of o.txns) {
    if (t.type !== "buy" && t.type !== "sell") continue;
    out.push({ at: `${t.trade_date}T12:00:00`, dot: "nw", head: txnType(t.type).replace(/^./, (c) => c.toUpperCase()), fact: `${qty(t.quantity)} @ ${money(t.price, t.currency)}`, key: `t:${t.id}` });
  }
  const time = (iso: string) => { const t = parseServerTime(iso); return Number.isNaN(t) ? 0 : t; };
  return out.sort((a, b) => time(b.at) - time(a.at) || b.key.localeCompare(a.key)).slice(0, limit);
}

/** A timeline date: `5.10` this year, `5.10.25` older. */
export const tlDate = (at: string, year: string) => (at.slice(0, 4) === year ? dm(at) : `${dm(at)}.${at.slice(2, 4)}`);
