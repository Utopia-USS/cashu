// The weekly review as a deck of cards (pure logic of ReviewDeck.tsx): from the general to the specific, one
// context per card, a card with nothing to say this week is skipped. Order: Czy świat się wali, Sektory,
// Pozycje, Wydarzenia, Do decyzji, Okazje, Kalendarz, then the summary. Verdicts are facts in plain Polish.
import { pct } from "../labels.ts";
import { HEALTH_LABEL, normHealth } from "./research/logic.ts";
import type { DigestResearch, MacroChange, ResearchNote, SegmentAttribution, ThesisChange } from "./research/types.ts";
import type { SignalV2 } from "./api.ts";
import { polarityOf, signalText } from "./logic.ts";
import { proposalSummary } from "../../../core/messages.ts";
import { CARD, PROPOSAL_TAG_L, S } from "./reviewDeckLogic.strings.ts";

export type CardId = "world" | "sectors" | "positions" | "events" | "decide" | "ideas" | "calendar";
export const CARD_ORDER: CardId[] = ["world", "sectors", "positions", "events", "decide", "ideas", "calendar"];
export const CARD_TITLE: Record<CardId, string> = CARD;
export type Tone = "pos" | "neg" | "warn" | "info";

/** A move this large or more counts on the Pozycje card. */
export const MOVER_MIN = 0.03;
const MAX_MOVERS = 3;
const MAX_DECIDE = 5;
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

export type DecideAction = { label: string; action: string };
export interface DecideItem {
  key: string; kind: "signal" | "thesis" | "proposal"; tone: Tone; tag: string; title: string; why: string;
  actions: DecideAction[]; signalId?: number; instrumentId?: number | null; proposalId?: number;
}

const snooze = (): DecideAction => ({ label: S.snooze, action: "snooze" });

function signalItem(s: SignalV2, names?: Map<number, string>): DecideItem {
  const pol = polarityOf(s);
  const t = signalText(s, { names });
  const why = [t.lead, t.bold, t.tail].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const actions: DecideAction[] = pol === "positive"
    ? [{ label: S.buyMore, action: "bought" }, { label: S.noChange, action: "held" }, snooze()]
    : pol === "negative"
      ? [{ label: S.selling, action: "sold" }, { label: S.noChange, action: "held" }, snooze()]
      : [{ label: S.accepted, action: "ack" }, { label: S.skip, action: "ignored" }, snooze()];
  return {
    key: `s:${s.id}`, kind: "signal", tone: pol === "positive" ? "pos" : pol === "negative" ? "neg" : "info",
    tag: `${pol === "positive" ? S.opportunity : pol === "negative" ? S.risk : S.signal}${s.severity === "action" ? S.toAct : ""}`,
    title: t.title, why: why || s.message, actions, signalId: s.id, instrumentId: s.instrument_id,
  };
}

function thesisItem(c: ThesisChange, names?: Map<number, string>): DecideItem | null {
  const to = normHealth(c.to);
  if (to !== "inv" && to !== "weak" && to !== "ful") return null;
  const from = normHealth(c.from);
  const name = names?.get(c.instrument_id) ?? c.label ?? c.symbol ?? `#${c.instrument_id}`;
  return {
    key: `t:${c.instrument_id}`, kind: "thesis", tone: to === "ful" ? "pos" : "neg", tag: S.thesisTag,
    title: S.thesisTitle(name, HEALTH_LABEL[to]),
    why: `${from ? S.was(HEALTH_LABEL[from]) : ""}${to === "ful" ? S.fulfilledWhy : S.againstWhy}`,
    actions: [{ label: S.reviewThesis, action: "review" }, { label: S.keep, action: "keep" }], instrumentId: c.instrument_id,
  };
}

export interface ProposalLike { id: number; kind: string; summary?: string | null; summary_code?: string | null; summary_params?: Record<string, unknown> | null }

const PROPOSAL_TAG: Record<string, string> = PROPOSAL_TAG_L;

function proposalItem(p: ProposalLike): DecideItem {
  return {
    key: `p:${p.id}`, kind: "proposal", tone: "info", tag: S.proposalTag(PROPOSAL_TAG[p.kind] ?? p.kind),
    title: proposalSummary(p as Parameters<typeof proposalSummary>[0]) ?? p.summary ?? S.proposal, why: S.awaitsApproval,
    actions: [{ label: S.view, action: "open" }], proposalId: p.id,
  };
}

/** What waits for the owner: thesis health that got worse (or fulfilled) this week, the agent's pending
 * proposals, then open undecided signals (action severity and risks first); at most 5, `more` = how many stay
 * in Sygnały. */
export function decideItems(signals: SignalV2[], research: DigestResearch | null | undefined, names?: Map<number, string>, proposals: ProposalLike[] = []): { items: DecideItem[]; more: number } {
  const theses = [
    ...(research?.theses_changed ?? []).map((c) => thesisItem(c, names)).filter((x): x is DecideItem => !!x),
    ...proposals.map(proposalItem),
  ];
  const open = signals
    .filter((s) => !s.snoozed && !s.decisions.length && (s.status === "active" || s.status === "acknowledged"))
    .sort((a, b) => sevRank(a) - sevRank(b) || polRank(a) - polRank(b));
  const all = [...theses, ...open.map((s) => signalItem(s, names))];
  return { items: all.slice(0, MAX_DECIDE), more: Math.max(0, all.length - MAX_DECIDE) };
}
const sevRank = (s: SignalV2) => (s.severity === "action" ? 0 : 1);
const polRank = (s: SignalV2) => ({ negative: 0, positive: 1 } as Record<string, number>)[polarityOf(s)] ?? 2;

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
