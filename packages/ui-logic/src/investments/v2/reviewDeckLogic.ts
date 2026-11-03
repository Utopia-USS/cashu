// The weekly review as a deck of cards (pure logic of ReviewDeck.tsx): from the general to the specific, one
// context per card, a card with nothing to say this week is skipped. Order: Czy świat się wali, Sektory,
// Pozycje, Wydarzenia, Okazje, Kalendarz, Do decyzji last (what needs the owner closes the review), then the
// summary. Verdicts are facts in plain Polish.

import { views as reviewDomain } from "@cashu/domain/investments";
import { proposalSummary } from "../../core/messages.js";
import { parseServerTime } from "../../core/time.js";
import { pct, pctTarget } from "../labels.js";
import { polarityOf, signalSubject, signalText } from "./logic.js";
import { HEALTH_LABEL, normHealth } from "./research/logic.js";
import type {
  DigestResearch,
  MacroChange,
  ResearchNote,
  SegmentAttribution,
  ThesisChange,
} from "./research/types.js";
import {
  CARD,
  GROUP_L,
  GROUP_TAG_L,
  PROPOSAL_TAG_L,
  REL_TAG_L,
  S,
} from "./reviewDeckLogic.strings.js";
import type { SignalV2 } from "./types.js";

export type CardId = "world" | "sectors" | "positions" | "events" | "decide" | "ideas" | "calendar";
export const CARD_ORDER: CardId[] = [
  "world",
  "sectors",
  "positions",
  "events",
  "ideas",
  "calendar",
  "decide",
];
export const CARD_TITLE: Record<CardId, string> = CARD;
export type Tone = "pos" | "neg" | "warn" | "info";

/** A move this large or more counts on the Pozycje card. */
export const MOVER_MIN = 0.03;

// ---- Czy świat się wali --------------------------------------------------------------------------------------

interface TwrPoint {
  date: string;
  twr: number | null;
}

/** The portfolio's typical weekly move: the standard deviation of its 7-day TWR changes over the points given
 * (a year); null with fewer than 8 weeks of history. */
export function weeklySigma(points: TwrPoint[]): number | null {
  return reviewDomain.reviewWeeklySigma(points);
}

export type MoveSize = "calm" | "strong" | "rare";
export type VsMarket = "worse" | "better" | "inline";
export interface WorldVerdict {
  tone: Tone;
  pill: string;
  title: string;
  size: MoveSize | null;
  vs: VsMarket | null;
}

/** How big the week was for this portfolio (vs its typical week) and how it went against the benchmark. */
export function worldVerdict(
  move: number | null,
  bench: number | null,
  sigma: number | null,
): WorldVerdict {
  if (move == null)
    return {
      tone: "info",
      pill: S.noValuationPill,
      title: S.noValuationTitle,
      size: null,
      vs: null,
    };
  const { size, vs, down } = reviewDomain.reviewWorldVerdict(move, bench, sigma);
  if (size === null) throw new Error("valued review move requires a verdict");
  const head =
    size === "calm"
      ? S.calmWeek
      : size === "strong"
        ? down
          ? S.strongDown
          : S.strongUp
        : down
          ? S.rareDown
          : S.rareUp;
  const tail =
    vs == null
      ? ""
      : size === "calm"
        ? { inline: S.calmInline, worse: S.calmWorse, better: S.calmBetter }[vs]
        : down
          ? { inline: S.downInline, worse: S.downWorse, better: S.downBetter }[vs]
          : { inline: S.upInline, worse: S.upWorse, better: S.upBetter }[vs];
  const pill =
    size === "calm"
      ? S.pillNormal
      : size === "strong"
        ? down
          ? S.pillStrongDown
          : S.pillStrongUp
        : S.pillRare;
  const tone: Tone = size === "calm" ? "pos" : down ? "neg" : "pos";
  return { tone, pill, title: head + tail, size, vs };
}

// ---- Sektory, Pozycje ----------------------------------------------------------------------------------------

export interface SectorRow {
  key: string;
  label: string;
  contribution: number;
  ret: number | null;
  weight: number | null;
  currency?: boolean;
}

/** The week's contributions by market segment, biggest first (at most 6), plus the currency part when it
 * moved the portfolio by 0.1 pp or more. */
export function sectorRows(att: SegmentAttribution | null | undefined): SectorRow[] {
  if (!att) return [];
  return reviewDomain.reviewSectorRows<SectorRow>(
    att.segments.map((s) => ({
      key: s.segment,
      label: s.label,
      contribution: s.contribution,
      ret: s.return,
      weight: s.weight,
    })),
    att.unassigned
      ? {
          key: "unassigned",
          label: S.noTopic,
          contribution: att.unassigned.contribution,
          ret: att.unassigned.return,
          weight: att.unassigned.weight,
        }
      : null,
    {
      key: "currency",
      label: S.currencies,
      contribution: att.currency?.contribution ?? 0,
      ret: null,
      weight: null,
      currency: true,
    },
  );
}

/** Headline of the Sektory card: which segments made most of the move. */
export function sectorsTitle(
  rows: SectorRow[],
  move: number | null,
): { title: string; pill: string; tone: Tone } {
  const verdict = reviewDomain.reviewSectorVerdict(rows, move);
  const names = verdict.names.join(S.and),
    first = verdict.names[0] ?? "";
  if (verdict.code === "empty") return { title: S.noSectors, pill: "-", tone: "info" };
  if (verdict.code === "all_plus")
    return { title: S.carriesAll(first), pill: S.allPlus, tone: "pos" };
  if (verdict.code === "all_minus")
    return { title: S.allMinusTitle(first), pill: S.allMinus, tone: "neg" };
  return {
    title:
      verdict.code === "share"
        ? S.shareOfMove(names, Math.round((verdict.share ?? 0) * 100), verdict.down)
        : S.spread(names),
    pill: verdict.down ? S.pillDown : S.pillUp,
    tone: verdict.down ? "neg" : "pos",
  };
}

export interface Mover {
  id: number;
  label: string;
  ret: number;
  contribution: number;
}

/** Held instruments by their own weekly return: the biggest fall and rise (at most 3 each). */
export function topMovers(
  att: SegmentAttribution | null | undefined,
  names?: Map<number, string>,
): { down: Mover[]; up: Mover[]; all: Mover[] } {
  if (!att) return { down: [], up: [], all: [] };
  const seen = new Map<number, Mover>();
  const add = (
    list: {
      instrument_id: number;
      return: number | null;
      contribution: number;
      label?: string | null;
    }[],
  ) => {
    for (const i of list)
      if (i.return != null && !seen.has(i.instrument_id)) {
        seen.set(i.instrument_id, {
          id: i.instrument_id,
          label: names?.get(i.instrument_id) ?? i.label ?? `#${i.instrument_id}`,
          ret: i.return,
          contribution: i.contribution,
        });
      }
  };
  for (const s of att.segments) add(s.instruments);
  if (att.unassigned) add(att.unassigned.instruments);
  return reviewDomain.reviewMovers([...seen.values()]);
}

// ---- Wydarzenia ------------------------------------------------------------------------------------------------

export interface DeckEvent {
  note: ResearchNote;
  score: number;
}

/** The week's research notes that matter most: thesis-relevant first, then strength (news, earnings, macro,
 * trend; not dismissed). */
export function weekEvents(notes: ResearchNote[]): DeckEvent[] {
  return reviewDomain.reviewEvents(notes, (n) => ({
    dismissed: !!n.dismissed_at,
    kind: String(n.kind),
    strength: n.strength ?? null,
    relation: n.thesis_relation ?? null,
    observedAt: n.observed_at,
  }));
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
  key: string;
  kind: "subject" | "rules" | "thesis" | "proposal";
  group: DecideGroup;
  tone: Tone;
  tag: string;
  title: string;
  /** What happened, one sentence. */
  why: string;
  /** What it means for the owner: the other facts in words, then the thesis line (exit plan / when it fails). */
  context?: string;
  actions: DecideAction[];
  signalIds?: number[];
  instrumentId?: number | null;
  proposalId?: number;
  /** A subject: a signal of it is new since the last review (the home rail's "Nowe"). */
  fresh?: boolean;
  /** A subject: when its newest signal was first seen (ms; the rail tells what predates the last review). */
  seenAt?: number;
  /** A subject whose every signal is snoozed (`includeSnoozed` only): the earliest end of the snooze. */
  snoozedUntil?: string | null;
}
/** The undecided rest: subjects whose state did not change (the review's "bez zmian") and news for Research. */
export interface DecideRest {
  review: number;
  research: number;
}
/** The parts of a thesis the card reads (api.ts Thesis). */
export interface ThesisLite {
  invalidation: string | null;
  exit_plan: string | null;
  exit_plan_changed_at?: string | null;
}

/** A rule signal of a portfolio rule (no instrument) hanging this long without a decision is suspect. */
export const STALE_RULE_DAYS = 14;
/** "New" counts from the last review, but never further back than this: without a review for weeks, a state that
 * has lasted that long is not news (it is counted as unchanged). */
export const NEW_MAX_DAYS = 14;
const MAX_DECIDE = 6;
const CHANGING = new Set(["weakens", "invalidates", "fulfills"]);
/** Rule kinds measured against a threshold, whose steps on one instrument form a ladder. */
const HEALTH_RELATION: Record<string, string> = {
  inv: "invalidates",
  weak: "weakens",
  ful: "fulfills",
};

const snooze = (): DecideAction => ({ label: S.snooze, action: "snooze" });
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const isResearch = (s: SignalV2) => s.kind.startsWith("research:");
const relationOf = (s: SignalV2) => (isResearch(s) ? str(s.payload.relation) : null);
const ts = parseServerTime;
const newer = (s: SignalV2, since: number) => Number.isFinite(since) && ts(s.first_seen_at) > since;
/** The baseline of "new" (ms): the last review, at most NEW_MAX_DAYS back. */
export const newSinceMs = (since: string | null | undefined, now: number) =>
  reviewDomain.reviewNewSince(ts(since ?? null), now);
const newSince = newSinceMs;

/** A share in words: "ponad 1/3", "ok. połowę"; below a tenth the percentage. */
export function shareWords(x: number): string {
  const a = Math.abs(x);
  const f = SHARES.find(([v]) => a >= v - 0.015);
  if (!f) return pctTarget(a);
  return a - f[0] < 0.02 ? S.about(f[1]) : S.over(f[1]);
}
const SHARES: [number, string][] = [
  [3 / 4, "3/4"],
  [2 / 3, "2/3"],
  [1 / 2, S.half],
  [1 / 3, "1/3"],
  [1 / 4, "1/4"],
  [1 / 5, "1/5"],
  [1 / 10, "1/10"],
];

/** One rule signal as a sentence of facts (no advice); unknown kinds fall back to the signal's own text. `fact`:
 * a supporting fact under another lead, without the threshold. */
function ruleSentence(s: SignalV2, names?: Map<number, string>, fact = false): string {
  const p = s.payload;
  switch (s.kind) {
    case "drawdown_from_high": {
      const d = num(p.drawdown),
        t = num(p.threshold);
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
  return (
    [t.lead, t.bold, t.tail]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/\s·$/, "")
      .trim() || s.message
  );
}

/** The thesis line: the exit plan when the decision is taken or the thesis played out, else when it fails. */
function thesisLine(
  t: ThesisLite | undefined,
  group: DecideGroup,
  fulfilled: boolean,
): string | null {
  const clean = (v: string | null) =>
    str(v?.replace(/\[(do potwierdzenia|to confirm)\]\s*/gi, "").replace(/\s+/g, " ") ?? null);
  const plan = clean(t?.exit_plan ?? null),
    inv = clean(t?.invalidation ?? null);
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

interface Subject {
  key: string;
  instrumentId: number | null;
  live: SignalV2[];
  ladder: SignalV2[];
}

/** Undecided open signals grouped per subject, ladders collapsed to their deepest step (the others in `ladder`). */
function reviewSignalFact(row: SignalV2) {
  return {
    id: row.id,
    instrument: row.instrument_id,
    rule: row.rule_id,
    kind: row.kind,
    polarity: polarityOf(row),
    relation: relationOf(row),
    firstSeen: ts(row.first_seen_at),
    threshold: num(row.payload.threshold) ?? 0,
    open: row.status === "active" || row.status === "acknowledged",
    snoozed: !!row.snoozed,
    decided: row.decisions.length > 0,
    bucket: row.payload.bucket_id == null ? null : String(row.payload.bucket_id),
    row,
  };
}
function subjectsOf(open: SignalV2[]): Subject[] {
  return reviewDomain.reviewSignalSubjects(open.map(reviewSignalFact)).map((sub) => ({
    key: sub.key,
    instrumentId: sub.instrument,
    live: sub.live.map((s) => s.row),
    ladder: sub.ladder.map((s) => s.row),
  }));
}

/** What waits for the owner (see the section comment): subject items grouped risk / chance / mixed / plan and the
 * thesis changes of the week (at most `limit`, 6, together), the agent's proposals (never cut), then one "rules to
 * fix" item. `since` = the last review (signals first seen after it are new), `theses` = the subjects' theses by
 * instrument id. The home rail adds `includeSnoozed` and `lastReviewAt`: a subject the last review put off (every
 * signal snoozed, or a rule signal that was new in that review and is still undecided) is an item too. */
export function decideItems(
  signals: SignalV2[],
  research: DigestResearch | null | undefined,
  names?: Map<number, string>,
  proposals: ProposalLike[] = [],
  opts: {
    since?: string | null;
    theses?: Map<number, ThesisLite>;
    now?: number;
    includeSnoozed?: boolean;
    lastReviewAt?: string | null;
    limit?: number;
  } = {},
): { items: DecideItem[]; more: number; rest: DecideRest } {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? MAX_DECIDE;
  const selection = reviewDomain.reviewDecideSelection(signals.map(reviewSignalFact), {
    now,
    since: ts(opts.since ?? null),
    health: healthChanges(research),
    includeSnoozed: !!opts.includeSnoozed,
    lastReviewAt: ts(opts.lastReviewAt ?? null),
  });
  const rest = selection.rest,
    stale = selection.stale.map((s) => s.row);
  const items = selection.selected.map((selected) => {
    const sub = selected.subject;
    return subjectItem(
      {
        key: sub.key,
        instrumentId: sub.instrument,
        live: sub.live.map((s) => s.row),
        ladder: sub.ladder.map((s) => s.row),
      },
      selected.changing?.row ?? null,
      selected.healthRelation,
      selected.fresh.map((s) => s.row),
      selected.isNew,
      selected.newTag,
      names,
      sub.instrument !== null ? opts.theses?.get(sub.instrument) : undefined,
    );
  });
  const covered = new Set(items.map((d) => d.instrumentId).filter((x) => x != null));
  const theses = (research?.theses_changed ?? [])
    .filter((c) => !covered.has(c.instrument_id))
    .map((c) => thesisItem(c, names))
    .filter((x): x is DecideItem => !!x);
  const ordered = [...items, ...theses].sort(
    (a, b) => DECIDE_GROUPS.indexOf(a.group) - DECIDE_GROUPS.indexOf(b.group),
  );
  // The agent's proposals wait for an approval only the owner can give: never cut by the limit.
  const shown = [...ordered.slice(0, limit), ...proposals.map(proposalItem)];
  if (stale.length) shown.push(rulesItem(stale));
  return { items: shown, more: Math.max(0, ordered.length - limit), rest };
}

/** `fresh`: the signals that speak when no thesis change does (the new ones, else the ones the review put off);
 * `isNew` / `newTag`: the subject counts as new for the rail / its tag says "nowe". */
function subjectItem(
  sub: Subject,
  changing: SignalV2 | null,
  healthRel: string | null,
  fresh: SignalV2[],
  isNew: boolean,
  newTag: boolean,
  names: Map<number, string> | undefined,
  thesis: ThesisLite | undefined,
): DecideItem {
  const all = [...sub.live, ...sub.ladder];
  const rel = changing ? relationOf(changing) : healthRel;
  const fulfilled = rel === "fulfills";
  const lastSeen = Math.max(...all.map((s) => ts(s.first_seen_at)).filter(Number.isFinite));
  const group = reviewDomain.reviewSubjectGroup({
    relation: rel,
    polarities: fresh.map(polarityOf),
    hasExitPlan: !!str(thesis?.exit_plan ?? null),
    exitPlanChangedAt: ts(thesis?.exit_plan_changed_at ?? null),
    lastSeen,
  });
  const lead = changing ?? fresh[0] ?? null;
  const any = lead ?? sub.live[0];
  if (!any) throw new Error("a review deck subject without signals");
  const name =
    (sub.instrumentId != null ? names?.get(sub.instrumentId) : null) ??
    signalText(any, { names }).title ??
    any.message;
  const why = changing
    ? (str(changing.payload.headline) ?? str(changing.payload.title) ?? changing.message)
    : lead
      ? ruleSentence(lead, names)
      : fulfilled
        ? S.fulfilledWhy
        : S.againstWhy;
  const facts = sub.live
    .filter((s) => s !== lead && !isResearch(s))
    .map((s) => ruleSentence(s, names, true));
  const steps = lead ? sub.ladder.filter((s) => s.kind === lead.kind) : [];
  if (steps.length)
    facts.unshift(
      S.ladder(steps.length + 1, dmIso(steps.map((s) => s.first_seen_at ?? "").sort()[0] ?? "")),
    );
  const context =
    [...facts, thesisLine(thesis, group, fulfilled)].filter(Boolean).join(" ") || undefined;
  const tag = `${GROUP_TAG[group]}${rel ? ` · ${REL_TAG[rel] ?? ""}` : newTag ? ` · ${S.newSignal}` : ""}`;
  const snoozed = all.every((s) => s.snoozed)
    ? (all
        .map((s) => s.snoozed_until ?? "")
        .filter(Boolean)
        .sort()[0] ?? null)
    : null;
  return {
    key: `s:${sub.key}`,
    kind: "subject",
    group,
    tone: GROUP_TONE[group],
    tag,
    title: name,
    why,
    context,
    fresh: isNew,
    seenAt: lastSeen,
    snoozedUntil: snoozed,
    // A portfolio rule (no instrument) has nothing to buy or sell: it is noted or snoozed.
    actions: sub.instrumentId == null ? ACTIONS.mixed() : ACTIONS[group](),
    signalIds: all.map((s) => s.id),
    instrumentId: sub.instrumentId,
  };
}

function rulesItem(list: SignalV2[]): DecideItem {
  const rules = [...new Set(list.map((s) => signalSubject(s) || s.rule_id))];
  const oldest = list.map((s) => s.first_seen_at ?? "").sort()[0] ?? "";
  return {
    key: "rules",
    kind: "rules",
    group: "fix",
    tone: "warn",
    tag: S.fixTag,
    title: S.fixTitle(list.length),
    why: S.fixWhy(rules.join(", "), dmIso(oldest)),
    context: S.fixContext,
    actions: [{ label: S.accepted, action: "ack" }, snooze()],
    signalIds: list.map((s) => s.id),
    instrumentId: null,
  };
}

const dmIso = (iso: string) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : "");
const GROUP_TONE: Record<DecideGroup, Tone> = {
  risk: "neg",
  chance: "pos",
  mixed: "info",
  plan: "info",
  fix: "warn",
};
export const GROUP_LABEL: Record<DecideGroup, string> = GROUP_L;
const GROUP_TAG: Record<DecideGroup, string> = GROUP_TAG_L;
const REL_TAG: Record<string, string> = REL_TAG_L;
const ACTIONS: Record<DecideGroup, () => DecideAction[]> = {
  risk: () => [{ label: S.selling, action: "sold" }, { label: S.keep, action: "held" }, snooze()],
  chance: () => [
    { label: S.buyMore, action: "bought" },
    { label: S.noChange, action: "held" },
    snooze(),
  ],
  mixed: () => [{ label: S.accepted, action: "ack" }, snooze()],
  plan: () => [
    { label: S.planDone, action: "sold" },
    { label: S.planStands, action: "held" },
    snooze(),
  ],
  fix: () => [{ label: S.accepted, action: "ack" }, snooze()],
};

function thesisItem(c: ThesisChange, names?: Map<number, string>): DecideItem | null {
  const to = normHealth(c.to);
  if (to !== "inv" && to !== "weak" && to !== "ful") return null;
  const from = normHealth(c.from);
  const name = names?.get(c.instrument_id) ?? c.label ?? c.symbol ?? `#${c.instrument_id}`;
  return {
    key: `t:${c.instrument_id}`,
    kind: "thesis",
    group: to === "ful" ? "chance" : "risk",
    tone: to === "ful" ? "pos" : "neg",
    tag: S.thesisTag,
    title: S.thesisTitle(name, HEALTH_LABEL[to]),
    why: `${from ? S.was(HEALTH_LABEL[from]) : ""}${to === "ful" ? S.fulfilledWhy : S.againstWhy}`,
    actions: [
      { label: S.reviewThesis, action: "review" },
      { label: S.keep, action: "keep" },
    ],
    instrumentId: c.instrument_id,
  };
}

export interface ProposalLike {
  id: number;
  kind: string;
  summary?: string | null;
  summary_code?: string | null;
  summary_params?: Record<string, unknown> | null;
}

const PROPOSAL_TAG: Record<string, string> = PROPOSAL_TAG_L;

function proposalItem(p: ProposalLike): DecideItem {
  return {
    key: `p:${p.id}`,
    kind: "proposal",
    group: "mixed",
    tone: "info",
    tag: S.proposalTag(PROPOSAL_TAG[p.kind] ?? p.kind),
    title: proposalSummary(p as Parameters<typeof proposalSummary>[0]) ?? p.summary ?? S.proposal,
    why: S.awaitsApproval,
    actions: [{ label: S.view, action: "open" }],
    proposalId: p.id,
  };
}

/** Instruments whose thesis the card needs (subjects with a reason), so the caller can load them first. */
export function decideSubjects(
  signals: SignalV2[],
  since?: string | null,
  research?: DigestResearch | null,
  now = Date.now(),
): number[] {
  const s0 = newSince(since, now);
  const health = healthChanges(research);
  const open = signals.filter(
    (s) =>
      !s.snoozed && !s.decisions.length && (s.status === "active" || s.status === "acknowledged"),
  );
  return subjectsOf(open).flatMap((sub) => {
    const id = sub.instrumentId;
    return id != null &&
      (health.has(id) ||
        sub.live.some((s) => CHANGING.has(relationOf(s) ?? "") || (!isResearch(s) && newer(s, s0))))
      ? [id]
      : [];
  });
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
  return reviewDomain.reviewIdeas(candidates, now, (n) => ({
    kind: String(n.kind),
    dismissed: !!n.dismissed_at,
    accepted: !!n.candidate?.accepted_at,
    expired: !!n.expired,
    expiresAt: n.expires_at ?? null,
    observedAt: n.observed_at,
  }));
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
export function deckCards(
  d: DeckInput,
  order: CardId[] = CARD_ORDER,
): { cards: CardId[]; skipped: { id: CardId; why: string }[] } {
  const why: Partial<Record<CardId, string>> = {};
  if (!d.sectors.some((r) => !r.currency)) why.sectors = S.skipSectors;
  const big = [...d.movers.down, ...d.movers.up].some((m) => Math.abs(m.ret) >= MOVER_MIN);
  if (!big) why.positions = S.skipPositions(pct(MOVER_MIN));
  if (!d.events.length && !d.macroChanges.length) why.events = S.skipEvents;
  if (!d.decide.length) why.decide = S.skipDecide;
  if (!d.ideas.length) why.ideas = S.skipIdeas;
  return {
    cards: order.filter((id) => !why[id]),
    skipped: order.flatMap((id) => {
      const reason = why[id];
      return reason ? [{ id, why: reason }] : [];
    }),
  };
}

/** Summary headline: how many cards go to the agent. */
export function summaryTitle(agenda: number): string {
  if (!agenda) return S.doneNothing;
  return S.doneAgenda(agenda);
}
