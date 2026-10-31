// The weekly review as a deck of cards (pure logic of ReviewDeck.tsx): from the general to the specific, one
// context per card, a card with nothing to say this week is skipped. Order: Czy świat się wali, Sektory,
// Pozycje, Wydarzenia, Okazje, Kalendarz, Do decyzji last (what needs the owner closes the review), then the
// summary. Verdicts are facts in plain Polish.
import { pct, pctTarget } from "../labels.ts";
import { HEALTH_LABEL, normHealth } from "./research/logic.ts";
import type { DigestResearch, MacroChange, ResearchNote, SegmentAttribution, ThesisChange } from "./research/types.ts";
import type { SignalV2 } from "./api.ts";
import { polarityOf, signalSubject, signalText } from "./logic.ts";
import { proposalSummary } from "../../../core/messages.ts";
import { parseServerTime } from "../../../time.ts";
import { CARD, GROUP_L, GROUP_TAG_L, PROPOSAL_TAG_L, REL_TAG_L, S } from "./reviewDeckLogic.strings.ts";

export type CardId = "world" | "sectors" | "positions" | "events" | "decide" | "ideas" | "calendar";
export const CARD_ORDER: CardId[] = ["world", "sectors", "positions", "events", "ideas", "calendar", "decide"];
export const CARD_TITLE: Record<CardId, string> = CARD;
export type Tone = "pos" | "neg" | "warn" | "info";

/** A move this large or more counts on the Pozycje card. */
export const MOVER_MIN = 0.03;
const MAX_MOVERS = 3;
const MAX_EVENTS = 4;
const MAX_IDEAS = 3;

// ---- Czy świat się wali --------------------------------------------------------------------------------------

interface TwrPoint { date: string; twr: number | null }

/** The portfolio's typical weekly move: the standard deviation of its 7-day TWR changes over the points given
 * (a year); null with fewer than 8 weeks of history. */
export function weeklySigma(points: TwrPoint[]): number | null {
  const pts = points.filter((p) => p.twr != null);
  const rets: number[] = [];
  let j = 0;
  for (let i = 0; i < pts.length; i++) {
    const cut = addDaysIso(pts[i].date, -7);
    while (j + 1 < i && pts[j + 1].date <= cut) j++;
    if (pts[j].date > cut) continue;
    const a = pts[j].twr!, b = pts[i].twr!;
    if (1 + a !== 0) rets.push((1 + b) / (1 + a) - 1);
  }
  if (rets.length < 40) return null; // ~8 weeks of daily points
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1));
  return sd > 0 ? sd : null;
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export type MoveSize = "calm" | "strong" | "rare";
export type VsMarket = "worse" | "better" | "inline";
export interface WorldVerdict { tone: Tone; pill: string; title: string; size: MoveSize | null; vs: VsMarket | null }

/** How big the week was for this portfolio (vs its typical week) and how it went against the benchmark. */
export function worldVerdict(move: number | null, bench: number | null, sigma: number | null): WorldVerdict {
  if (move == null) return { tone: "info", pill: S.noValuationPill, title: S.noValuationTitle, size: null, vs: null };
  const z = sigma ? Math.abs(move) / sigma : Math.abs(move) / 0.02;
  const size: MoveSize = z < 1 ? "calm" : z < 2 ? "strong" : "rare";
  const diff = bench == null ? null : move - bench;
  const vs: VsMarket | null = diff == null ? null : Math.abs(diff) < 0.01 ? "inline" : diff < 0 ? "worse" : "better";
  const down = move < 0;
  const head = size === "calm" ? S.calmWeek : size === "strong" ? (down ? S.strongDown : S.strongUp) : down ? S.rareDown : S.rareUp;
  const tail = vs == null ? "" : size === "calm"
    ? { inline: S.calmInline, worse: S.calmWorse, better: S.calmBetter }[vs]
    : down
      ? { inline: S.downInline, worse: S.downWorse, better: S.downBetter }[vs]
      : { inline: S.upInline, worse: S.upWorse, better: S.upBetter }[vs];
  const pill = size === "calm" ? S.pillNormal : size === "strong" ? (down ? S.pillStrongDown : S.pillStrongUp) : S.pillRare;
  const tone: Tone = size === "calm" ? "pos" : down ? "neg" : "pos";
  return { tone, pill, title: head + tail, size, vs };
}

// ---- Sektory, Pozycje ----------------------------------------------------------------------------------------

export interface SectorRow { key: string; label: string; contribution: number; ret: number | null; weight: number | null; currency?: boolean }

/** The week's contributions by market segment, biggest first (at most 6), plus the currency part when it
 * moved the portfolio by 0.1 pp or more. */
export function sectorRows(att: SegmentAttribution | null | undefined): SectorRow[] {
  if (!att) return [];
  const rows: SectorRow[] = att.segments
    .filter((s) => s.weight > 0 || s.contribution !== 0)
    .map((s) => ({ key: s.segment, label: s.label, contribution: s.contribution, ret: s.return, weight: s.weight }));
  if (att.unassigned && att.unassigned.weight > 0) rows.push({ key: "unassigned", label: S.noTopic, contribution: att.unassigned.contribution, ret: att.unassigned.return, weight: att.unassigned.weight });
  rows.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const out = rows.slice(0, 6);
  if (Math.abs(att.currency?.contribution ?? 0) >= 0.001) out.push({ key: "currency", label: S.currencies, contribution: att.currency.contribution, ret: null, weight: null, currency: true });
  return out;
}

/** Headline of the Sektory card: which segments made most of the move. */
export function sectorsTitle(rows: SectorRow[], move: number | null): { title: string; pill: string; tone: Tone } {
  const real = rows.filter((r) => !r.currency);
  if (!real.length) return { title: S.noSectors, pill: "-", tone: "info" };
  const total = real.reduce((x, r) => x + r.contribution, 0);
  const sign = Math.sign(move ?? total) || 1;
  const same = real.filter((r) => Math.sign(r.contribution) === sign);
  if (real.every((r) => r.contribution >= 0)) return { title: S.carriesAll(real[0].label), pill: S.allPlus, tone: "pos" };
  if (real.every((r) => r.contribution <= 0)) return { title: S.allMinusTitle(real[0].label), pill: S.allMinus, tone: "neg" };
  const top = same.slice(0, 2);
  const share = top.reduce((x, r) => x + r.contribution, 0) / (same.reduce((x, r) => x + r.contribution, 0) || 1);
  const names = top.map((r) => r.label).join(S.and);
  return { title: share >= 0.6 ? S.shareOfMove(names, Math.round(share * 100), sign < 0) : S.spread(names), pill: sign < 0 ? S.pillDown : S.pillUp, tone: sign < 0 ? "neg" : "pos" };
}

export interface Mover { id: number; label: string; ret: number; contribution: number }

/** Held instruments by their own weekly return: the biggest fall and rise (at most 3 each). */
export function topMovers(att: SegmentAttribution | null | undefined, names?: Map<number, string>): { down: Mover[]; up: Mover[]; all: Mover[] } {
  if (!att) return { down: [], up: [], all: [] };
  const seen = new Map<number, Mover>();
  const add = (list: { instrument_id: number; return: number | null; contribution: number; label?: string | null }[]) => {
    for (const i of list) if (i.return != null && !seen.has(i.instrument_id)) {
      seen.set(i.instrument_id, { id: i.instrument_id, label: names?.get(i.instrument_id) ?? i.label ?? `#${i.instrument_id}`, ret: i.return, contribution: i.contribution });
    }
  };
  for (const s of att.segments) add(s.instruments);
  if (att.unassigned) add(att.unassigned.instruments);
  const all = [...seen.values()].sort((a, b) => a.ret - b.ret);
  return {
    down: all.filter((m) => m.ret < 0).slice(0, MAX_MOVERS),
    up: all.filter((m) => m.ret > 0).reverse().slice(0, MAX_MOVERS),
    all,
  };
}

// ---- Wydarzenia ------------------------------------------------------------------------------------------------

const RELATION_SCORE: Record<string, number> = { invalidates: 3, weakens: 2, fulfills: 2, supports: 1 };
export interface DeckEvent { note: ResearchNote; score: number }

/** The week's research notes that matter most: thesis-relevant first, then strength (news, earnings, macro,
 * trend; not dismissed). */
export function weekEvents(notes: ResearchNote[]): DeckEvent[] {
  return notes
    .filter((n) => !n.dismissed_at && ["news", "earnings", "macro", "trend"].includes(String(n.kind)))
    .map((n) => ({ note: n, score: (n.strength ?? 1) + (RELATION_SCORE[String(n.thesis_relation)] ?? 0) }))
    .filter((e) => e.score >= 2)
    .sort((a, b) => b.score - a.score || b.note.observed_at.localeCompare(a.note.observed_at))
    .slice(0, MAX_EVENTS);
}

// ---- Do decyzji ------------------------------------------------------------------------------------------------
// The card answers "what needs me": one item per subject (an instrument, else a rule), and only with a reason.
// A reason is research that changes the thesis (weakens, invalidates, fulfills; a research signal or the week's
// thesis health) or a signal new since the last review. Threshold rules of one kind and polarity on one
// instrument form a ladder (reserve tranches at -15 / -25 / -35 %): the deepest step speaks for them. A thesis
// whose exit plan changed after the signals means the decision is taken: the item moves to "W toku". Everything
// else is counted on one line (unchanged states for the review, news for Research), and portfolio rules that
// hang for weeks without a decision become one "rules to fix" item.

export type DecideAction = { label: string; action: string };
export type DecideGroup = "risk" | "chance" | "mixed" | "plan" | "fix";
export const DECIDE_GROUPS: DecideGroup[] = ["risk", "chance", "mixed", "plan", "fix"];
export interface DecideItem {
  key: string; kind: "subject" | "rules" | "thesis" | "proposal"; group: DecideGroup; tone: Tone; tag: string; title: string;
  /** What happened, one sentence. */
  why: string;
  /** What it means for the owner: the other facts in words, then the thesis line (exit plan / when it fails). */
  context?: string;
  actions: DecideAction[]; signalIds?: number[]; instrumentId?: number | null; proposalId?: number;
  /** A subject: a signal of it is new since the last review (the home rail's "Nowe"). */
  fresh?: boolean;
  /** A subject: when its newest signal was first seen (ms; the rail tells what predates the last review). */
  seenAt?: number;
  /** A subject whose every signal is snoozed (`includeSnoozed` only): the earliest end of the snooze. */
  snoozedUntil?: string | null;
}
/** The undecided rest: subjects whose state did not change (the review's "bez zmian") and news for Research. */
export interface DecideRest { review: number; research: number }
/** The parts of a thesis the card reads (api.ts Thesis). */
export interface ThesisLite { invalidation: string | null; exit_plan: string | null; exit_plan_changed_at?: string | null }

/** A rule signal of a portfolio rule (no instrument) hanging this long without a decision is suspect. */
export const STALE_RULE_DAYS = 14;
/** "New" counts from the last review, but never further back than this: without a review for weeks, a state that
 * has lasted that long is not news (it is counted as unchanged). */
export const NEW_MAX_DAYS = 14;
const MAX_DECIDE = 6;
const DAY = 86400000;
const CHANGING = new Set(["weakens", "invalidates", "fulfills"]);
/** Rule kinds measured against a threshold, whose steps on one instrument form a ladder. */
const LADDER_KINDS = new Set(["drawdown_from_high", "loss_from_cost", "gain_from_cost"]);
const HEALTH_RELATION: Record<string, string> = { inv: "invalidates", weak: "weakens", ful: "fulfills" };

const snooze = (): DecideAction => ({ label: S.snooze, action: "snooze" });
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const isResearch = (s: SignalV2) => s.kind.startsWith("research:");
const relationOf = (s: SignalV2) => (isResearch(s) ? str(s.payload.relation) : null);
const ts = parseServerTime;
const newer = (s: SignalV2, since: number) => Number.isFinite(since) && ts(s.first_seen_at) > since;
/** The baseline of "new" (ms): the last review, at most NEW_MAX_DAYS back. */
export const newSinceMs = (since: string | null | undefined, now: number) => {
  const cap = now - NEW_MAX_DAYS * DAY, at = ts(since ?? null);
  return Number.isFinite(at) ? Math.max(at, cap) : cap;
};
const newSince = newSinceMs;

/** A share in words: "ponad 1/3", "ok. połowę"; below a tenth the percentage. */
export function shareWords(x: number): string {
  const a = Math.abs(x);
  const f = SHARES.find(([v]) => a >= v - 0.015);
  if (!f) return pctTarget(a);
  return a - f[0] < 0.02 ? S.about(f[1]) : S.over(f[1]);
}
const SHARES: [number, string][] = [[3 / 4, "3/4"], [2 / 3, "2/3"], [1 / 2, S.half], [1 / 3, "1/3"], [1 / 4, "1/4"], [1 / 5, "1/5"], [1 / 10, "1/10"]];

/** One rule signal as a sentence of facts (no advice); unknown kinds fall back to the signal's own text. `fact`:
 * a supporting fact under another lead, without the threshold. */
function ruleSentence(s: SignalV2, names?: Map<number, string>, fact = false): string {
  const p = s.payload;
  switch (s.kind) {
    case "drawdown_from_high": {
      const d = num(p.drawdown), t = num(p.threshold);
      if (d != null) return S.ddSentence(shareWords(d), t != null && !fact ? pctTarget(-t) : null);
      break;
    }
    case "loss_from_cost": {
      const u = num(p.unrealized_pct);
      if (u != null) return S.lossSentence(shareWords(u));
      break;
    }
    case "gain_from_cost": {
      const u = num(p.unrealized_pct);
      if (u != null) return u >= 1 ? S.gainTimes(Math.floor(1 + u)) : S.gainSentence(shareWords(u));
      break;
    }
  }
  const t = signalText(s, { names });
  return [t.lead, t.bold, t.tail].filter(Boolean).join(" ").replace(/\s+/g, " ").replace(/\s·$/, "").trim() || s.message;
}

/** The thesis line: the exit plan when the decision is taken or the thesis played out, else when it fails. */
function thesisLine(t: ThesisLite | undefined, group: DecideGroup, fulfilled: boolean): string | null {
  const clean = (v: string | null) => str(v?.replace(/\[(do potwierdzenia|to confirm)\]\s*/gi, "").replace(/\s+/g, " ") ?? null);
  const plan = clean(t?.exit_plan ?? null), inv = clean(t?.invalidation ?? null);
  if (group === "plan" && plan) return S.yourPlan(firstSentence(plan));
  if (fulfilled) return plan ? S.yourPlan(firstSentence(plan)) : S.noExitPlan;
  if (group === "risk" && inv && inv !== "-") return S.failsWhen(firstSentence(inv));
  return null;
}
function firstSentence(v: string, max = 180): string {
  const m = v.match(/^.+?[.!?](?=\s|$)/);
  const s = (m ? m[0] : v).trim();
  return s.length > max ? `${s.slice(0, max).replace(/\s+\S*$/, "")}…` : s;
}

interface Subject { key: string; instrumentId: number | null; live: SignalV2[]; ladder: SignalV2[] }

/** Undecided open signals grouped per subject, ladders collapsed to their deepest step (the others in `ladder`). */
function subjectsOf(open: SignalV2[]): Subject[] {
  const by = new Map<string, SignalV2[]>();
  for (const s of open) {
    const k = s.instrument_id != null ? `i:${s.instrument_id}` : isResearch(s) ? `n:${s.id}`
      : s.kind === "allocation_drift" ? `b:${String(s.payload.bucket_id ?? "")}` : `r:${s.rule_id}`;
    by.set(k, [...(by.get(k) ?? []), s]);
  }
  return [...by.entries()].map(([key, list]) => {
    const live: SignalV2[] = [], ladder: SignalV2[] = [];
    const kinds = new Map<string, SignalV2[]>();
    for (const s of list) {
      if (!LADDER_KINDS.has(s.kind)) { live.push(s); continue; }
      const k = `${s.kind}|${polarityOf(s)}`;
      kinds.set(k, [...(kinds.get(k) ?? []), s]);
    }
    for (const steps of kinds.values()) {
      const sorted = [...steps].sort((a, b) => (num(b.payload.threshold) ?? 0) - (num(a.payload.threshold) ?? 0) || ts(b.first_seen_at) - ts(a.first_seen_at));
      live.push(sorted[0]);
      ladder.push(...sorted.slice(1));
    }
    return { key, instrumentId: list[0].instrument_id, live, ladder };
  });
}

/** What waits for the owner (see the section comment): subject items grouped risk / chance / mixed / plan and the
 * thesis changes of the week (at most `limit`, 6, together), the agent's proposals (never cut), then one "rules to
 * fix" item. `since` = the last review (signals first seen after it are new), `theses` = the subjects' theses by
 * instrument id. The home rail adds `includeSnoozed` and `lastReviewAt`: a subject the last review put off (every
 * signal snoozed, or a rule signal that was new in that review and is still undecided) is an item too. */
export function decideItems(signals: SignalV2[], research: DigestResearch | null | undefined, names?: Map<number, string>, proposals: ProposalLike[] = [],
  opts: { since?: string | null; theses?: Map<number, ThesisLite>; now?: number; includeSnoozed?: boolean; lastReviewAt?: string | null; limit?: number } = {},
): { items: DecideItem[]; more: number; rest: DecideRest } {
  const now = opts.now ?? Date.now();
  const since = newSince(opts.since, now);
  const reviewed = ts(opts.lastReviewAt ?? null);
  const limit = opts.limit ?? MAX_DECIDE;
  // In the last review's deck: a rule signal new then (at most NEW_MAX_DAYS before it) and still undecided now.
  const wasInReview = (s: SignalV2) => Number.isFinite(reviewed) && !isResearch(s) && ts(s.first_seen_at) <= reviewed && ts(s.first_seen_at) > reviewed - NEW_MAX_DAYS * DAY;
  // Snoozed signals wait out of the deck; the home rail asks for them (what the review put off).
  const open = signals.filter((s) => (opts.includeSnoozed || !s.snoozed) && !s.decisions.length && (s.status === "active" || s.status === "acknowledged"));
  const rest: DecideRest = { review: 0, research: 0 };
  const items: DecideItem[] = [];
  const stale: SignalV2[] = [];
  const health = healthChanges(research);
  for (const sub of subjectsOf(open)) {
    const all = [...sub.live, ...sub.ladder];
    const changing = sub.live.find((s) => CHANGING.has(relationOf(s) ?? ""));
    // A thesis weakened by a note too weak for its own signal still gives the instrument's open signals a reason.
    const healthRel = !changing && sub.instrumentId != null ? health.get(sub.instrumentId) ?? null : null;
    const fresh = sub.live.filter((s) => !isResearch(s) && newer(s, since));
    const carried = opts.includeSnoozed ? sub.live.filter((s) => s.snoozed || wasInReview(s)) : [];
    const putOff = carried.length > 0 && (all.every((s) => s.snoozed) || carried.some(wasInReview));
    if (!changing && !healthRel && !fresh.length && !putOff) {
      if (sub.instrumentId == null && !isResearch(sub.live[0]) && sub.live.every((s) => now - ts(s.first_seen_at) > STALE_RULE_DAYS * DAY)) stale.push(...all);
      else if (sub.live.some((s) => !isResearch(s) || relationOf(s) === "supports")) rest.review++;
      else rest.research++;
      continue;
    }
    // New for the rail: a new rule signal, research that changed the thesis since the review, or the week's health.
    const isNew = fresh.length > 0 || (!!changing && newer(changing, since)) || !!healthRel;
    items.push(subjectItem(sub, changing ?? null, healthRel, fresh.length ? fresh : carried, isNew, fresh.length > 0, names,
      sub.instrumentId != null ? opts.theses?.get(sub.instrumentId) : undefined));
  }
  const covered = new Set(items.map((d) => d.instrumentId).filter((x) => x != null));
  const theses = (research?.theses_changed ?? []).filter((c) => !covered.has(c.instrument_id)).map((c) => thesisItem(c, names)).filter((x): x is DecideItem => !!x);
  const ordered = [...items, ...theses].sort((a, b) => DECIDE_GROUPS.indexOf(a.group) - DECIDE_GROUPS.indexOf(b.group));
  // The agent's proposals wait for an approval only the owner can give: never cut by the limit.
  const shown = [...ordered.slice(0, limit), ...proposals.map(proposalItem)];
  if (stale.length) shown.push(rulesItem(stale, names));
  return { items: shown, more: Math.max(0, ordered.length - limit), rest };
}

/** `fresh`: the signals that speak when no thesis change does (the new ones, else the ones the review put off);
 * `isNew` / `newTag`: the subject counts as new for the rail / its tag says "nowe". */
function subjectItem(sub: Subject, changing: SignalV2 | null, healthRel: string | null, fresh: SignalV2[], isNew: boolean, newTag: boolean,
  names: Map<number, string> | undefined, thesis: ThesisLite | undefined): DecideItem {
  const all = [...sub.live, ...sub.ladder];
  const rel = changing ? relationOf(changing) : healthRel;
  const fulfilled = rel === "fulfills";
  // Polarity of what speaks: the thesis change, else the new signals.
  const pols = new Set((rel ? [fulfilled ? "positive" : "negative"] : fresh.map((s) => polarityOf(s))).filter((p) => p !== "neutral"));
  const lastSeen = Math.max(...all.map((s) => ts(s.first_seen_at)).filter(Number.isFinite));
  const planned = !!str(thesis?.exit_plan ?? null) && ts(thesis?.exit_plan_changed_at ?? null) > lastSeen + DAY;
  const group: DecideGroup = planned ? "plan" : pols.size === 1 ? (pols.has("negative") ? "risk" : "chance") : "mixed";
  const lead = changing ?? fresh[0] ?? null;
  const any = lead ?? sub.live[0];
  const name = (sub.instrumentId != null ? names?.get(sub.instrumentId) : null) ?? signalText(any, { names }).title ?? any.message;
  const why = changing ? (str(changing.payload.headline) ?? str(changing.payload.title) ?? changing.message)
    : lead ? ruleSentence(lead, names) : fulfilled ? S.fulfilledWhy : S.againstWhy;
  const facts = sub.live.filter((s) => s !== lead && !isResearch(s)).map((s) => ruleSentence(s, names, true));
  const steps = lead ? sub.ladder.filter((s) => s.kind === lead.kind) : [];
  if (steps.length) facts.unshift(S.ladder(steps.length + 1, dmIso(steps.map((s) => s.first_seen_at ?? "").sort()[0])));
  const context = [...facts, thesisLine(thesis, group, fulfilled)].filter(Boolean).join(" ") || undefined;
  const tag = `${GROUP_TAG[group]}${rel ? ` · ${REL_TAG[rel] ?? ""}` : newTag ? ` · ${S.newSignal}` : ""}`;
  const snoozed = all.every((s) => s.snoozed) ? all.map((s) => s.snoozed_until ?? "").filter(Boolean).sort()[0] ?? null : null;
  return {
    key: `s:${sub.key}`, kind: "subject", group, tone: GROUP_TONE[group], tag, title: name, why, context,
    fresh: isNew, seenAt: lastSeen, snoozedUntil: snoozed,
    // A portfolio rule (no instrument) has nothing to buy or sell: it is noted or snoozed.
    actions: sub.instrumentId == null ? ACTIONS.mixed() : ACTIONS[group](), signalIds: all.map((s) => s.id), instrumentId: sub.instrumentId,
  };
}

function rulesItem(list: SignalV2[], names?: Map<number, string>): DecideItem {
  const rules = [...new Set(list.map((s) => signalSubject(s) || s.rule_id))];
  const oldest = list.map((s) => s.first_seen_at ?? "").sort()[0];
  return {
    key: "rules", kind: "rules", group: "fix", tone: "warn", tag: S.fixTag, title: S.fixTitle(list.length), why: S.fixWhy(rules.join(", "), dmIso(oldest)),
    context: S.fixContext, actions: [{ label: S.accepted, action: "ack" }, snooze()], signalIds: list.map((s) => s.id), instrumentId: null,
  };
}

const dmIso = (iso: string) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "");
const GROUP_TONE: Record<DecideGroup, Tone> = { risk: "neg", chance: "pos", mixed: "info", plan: "info", fix: "warn" };
export const GROUP_LABEL: Record<DecideGroup, string> = GROUP_L;
const GROUP_TAG: Record<DecideGroup, string> = GROUP_TAG_L;
const REL_TAG: Record<string, string> = REL_TAG_L;
const ACTIONS: Record<DecideGroup, () => DecideAction[]> = {
  risk: () => [{ label: S.selling, action: "sold" }, { label: S.keep, action: "held" }, snooze()],
  chance: () => [{ label: S.buyMore, action: "bought" }, { label: S.noChange, action: "held" }, snooze()],
  mixed: () => [{ label: S.accepted, action: "ack" }, snooze()],
  plan: () => [{ label: S.planDone, action: "sold" }, { label: S.planStands, action: "held" }, snooze()],
  fix: () => [{ label: S.accepted, action: "ack" }, snooze()],
};

function thesisItem(c: ThesisChange, names?: Map<number, string>): DecideItem | null {
  const to = normHealth(c.to);
  if (to !== "inv" && to !== "weak" && to !== "ful") return null;
  const from = normHealth(c.from);
  const name = names?.get(c.instrument_id) ?? c.label ?? c.symbol ?? `#${c.instrument_id}`;
  return {
    key: `t:${c.instrument_id}`, kind: "thesis", group: to === "ful" ? "chance" : "risk", tone: to === "ful" ? "pos" : "neg", tag: S.thesisTag,
    title: S.thesisTitle(name, HEALTH_LABEL[to]),
    why: `${from ? S.was(HEALTH_LABEL[from]) : ""}${to === "ful" ? S.fulfilledWhy : S.againstWhy}`,
    actions: [{ label: S.reviewThesis, action: "review" }, { label: S.keep, action: "keep" }], instrumentId: c.instrument_id,
  };
}

export interface ProposalLike { id: number; kind: string; summary?: string | null; summary_code?: string | null; summary_params?: Record<string, unknown> | null }

const PROPOSAL_TAG: Record<string, string> = PROPOSAL_TAG_L;

function proposalItem(p: ProposalLike): DecideItem {
  return {
    key: `p:${p.id}`, kind: "proposal", group: "mixed", tone: "info", tag: S.proposalTag(PROPOSAL_TAG[p.kind] ?? p.kind),
    title: proposalSummary(p as Parameters<typeof proposalSummary>[0]) ?? p.summary ?? S.proposal, why: S.awaitsApproval,
    actions: [{ label: S.view, action: "open" }], proposalId: p.id,
  };
}

/** Instruments whose thesis the card needs (subjects with a reason), so the caller can load them first. */
export function decideSubjects(signals: SignalV2[], since?: string | null, research?: DigestResearch | null, now = Date.now()): number[] {
  const s0 = newSince(since, now);
  const health = healthChanges(research);
  const open = signals.filter((s) => !s.snoozed && !s.decisions.length && (s.status === "active" || s.status === "acknowledged"));
  return subjectsOf(open)
    .filter((sub) => sub.instrumentId != null && (health.has(sub.instrumentId)
      || sub.live.some((s) => CHANGING.has(relationOf(s) ?? "") || (!isResearch(s) && newer(s, s0)))))
    .map((sub) => sub.instrumentId!);
}

/** Thesis health that got worse (or fulfilled) this week, as the relation a research signal would carry. */
function healthChanges(research: DigestResearch | null | undefined): Map<number, string> {
  const out = new Map<number, string>();
  for (const c of research?.theses_changed ?? []) {
    const rel = HEALTH_RELATION[normHealth(c.to) ?? ""];
    if (rel) out.set(c.instrument_id, rel);
  }
  return out;
}

// ---- Okazje ------------------------------------------------------------------------------------------------------

/** Open candidates of the research (not dismissed, not accepted, not expired), newest first, at most 3. */
export function openIdeas(candidates: ResearchNote[], now = Date.now()): ResearchNote[] {
  return candidates
    .filter((n) => n.kind === "candidate" && !n.dismissed_at && !n.candidate?.accepted_at && !n.expired && (!n.expires_at || Date.parse(n.expires_at) > now))
    .sort((a, b) => b.observed_at.localeCompare(a.observed_at))
    .slice(0, MAX_IDEAS);
}

// ---- the deck ------------------------------------------------------------------------------------------------

export interface DeckInput {
  movers: { down: Mover[]; up: Mover[] };
  sectors: SectorRow[];
  events: DeckEvent[];
  macroChanges: MacroChange[];
  decide: DecideItem[];
  ideas: ResearchNote[];
}

/** The cards of this week in order, and the skipped ones with the reason (shown on the summary). */
export function deckCards(d: DeckInput, order: CardId[] = CARD_ORDER): { cards: CardId[]; skipped: { id: CardId; why: string }[] } {
  const why: Partial<Record<CardId, string>> = {};
  if (!d.sectors.some((r) => !r.currency)) why.sectors = S.skipSectors;
  const big = [...d.movers.down, ...d.movers.up].some((m) => Math.abs(m.ret) >= MOVER_MIN);
  if (!big) why.positions = S.skipPositions(pct(MOVER_MIN));
  if (!d.events.length && !d.macroChanges.length) why.events = S.skipEvents;
  if (!d.decide.length) why.decide = S.skipDecide;
  if (!d.ideas.length) why.ideas = S.skipIdeas;
  return {
    cards: order.filter((id) => !why[id]),
    skipped: order.filter((id) => why[id]).map((id) => ({ id, why: why[id]! })),
  };
}

/** Summary headline: how many cards go to the agent. */
export function summaryTitle(agenda: number): string {
  if (!agenda) return S.doneNothing;
  return S.doneAgenda(agenda);
}
