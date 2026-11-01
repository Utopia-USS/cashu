// The market segments view over a vault (Python `research/segment_service.py`, store side): the
// attribution of the performance computation (pure part in `@cashu/domain` research `segmentView`),
// cached on that computation like Python's `computed.extras`, joined with the segment notes, the
// topic theses and the watched instruments' trends. Note facts (latest note, unread, counts) are read
// fresh; watched instruments the computation does not hold get their bars from the device's price
// cache (public market data, never synced).

import { addDays } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import {
  type Instrument,
  type InstrumentId,
  market,
  type PriceBar,
  type performance as perf,
  research,
} from "@cashu/domain/investments";
import { watchedInstrumentGids } from "../queries/alerts.js";
import { loadInstruments } from "../queries/instruments.js";
import type { Read } from "../queries/shared.js";
import { isUnread, noteRows, topicThesesBySegment } from "./queries.js";
import { gidRanks, hasBrief, instantView, iso, type ResearchNote, truthy } from "./rows.js";
import { topicThesisView } from "./topics.js";

type Instant = research.Instant;
const DAY = research.MICROS_PER_DAY;

/** Python `brief_note`: a segment row's note. */
export function briefNote(r: ResearchNote | undefined) {
  if (r === undefined) return null;
  return {
    id: r.gid,
    title: r.title,
    observed_at: iso(r.observedAt),
    polarity: r.polarity,
    kind: r.kind,
    strength: r.strength,
  };
}

const briefOf = (r: ResearchNote): Readonly<Record<string, unknown>> =>
  (r.details?.brief ?? {}) as Readonly<Record<string, unknown>>;

/** Python `topic_brief`: a topic row's brief (P9). */
export function topicBrief(r: ResearchNote, now: Instant) {
  const brief = briefOf(r);
  return {
    note_id: r.gid,
    headline: brief.headline ?? null,
    why: brief.why ?? null,
    observed_at: iso(r.observedAt),
    kind: r.kind,
    polarity: r.polarity,
    unread: isUnread(r, now),
  };
}

/** Python `macro_brief`: a macro card's brief (P9). */
export function macroBrief(r: ResearchNote | undefined, now: Instant) {
  if (r === undefined) return null;
  const brief = briefOf(r);
  const list = (v: unknown) => (Array.isArray(v) ? [...v] : []);
  return {
    note_id: r.gid,
    headline: brief.headline ?? null,
    why: brief.why ?? null,
    supports: list(brief.supports),
    risks: list(brief.risks),
    observed_at: iso(r.observedAt),
    unread: isUnread(r, now),
  };
}

/** Python `topic_valuation`: the newest valuation note's figures, its date and its sources' publishers. */
export function topicValuation(r: ResearchNote | undefined) {
  if (r === undefined) return null;
  const sources = r.sources.flatMap((s) => {
    if (typeof s !== "object" || s === null) return [];
    const o = s as Record<string, unknown>;
    return [o.publisher || o.url];
  });
  return {
    ...((r.details?.valuation ?? {}) as Record<string, unknown>),
    note_id: r.gid,
    observed_at: iso(r.observedAt),
    sources: sources.slice(0, 3),
  };
}

interface Notes {
  latest?: ResearchNote;
  newest?: ResearchNote;
  unread: number;
  notes8w: number;
  briefs: ResearchNote[];
  valuation?: ResearchNote;
}

/**
 * Python `notes_by_segment`: per segment the newest active note, the newest stored one, unread agent
 * notes, the notes of the last 8 weeks and the active briefs (dismissed notes left out).
 */
export function notesBySegment(read: Read, now: Instant): Map<string, Notes> {
  const since8w = now - BigInt(7 * research.NOTES_WEEKS) * DAY;
  const reach = Math.max(7 * research.NOTES_WEEKS, research.EXPIRES_MAX_DAYS) + 1;
  const rows = noteRows(read, "n.segment IS NOT NULL AND n.observed_at >= ?", [
    instantView(now - BigInt(reach) * DAY),
  ]);
  const ranks = gidRanks(rows);
  const key = (r: ResearchNote) => [r.observedAt, ranks.get(r.gid) ?? 0] as const;
  const newer = (a: ResearchNote | undefined, b: ResearchNote) => {
    if (a === undefined) return true;
    const [ao, ai] = key(a);
    const [bo, bi] = key(b);
    return bo > ao || (bo === ao && bi > ai);
  };
  const out = new Map<string, Notes>();
  for (const r of rows) {
    if (r.dismissedAt !== null || r.segment === null) continue;
    const entry = out.get(r.segment) ?? { unread: 0, notes8w: 0, briefs: [] };
    out.set(r.segment, entry);
    if (newer(entry.newest, r)) entry.newest = r;
    const active = r.expiresAt > now;
    if (active && newer(entry.latest, r)) entry.latest = r;
    if (active && hasBrief(r.details)) entry.briefs.push(r);
    if (active && truthy(r.details?.valuation) && newer(entry.valuation, r)) entry.valuation = r;
    if (isUnread(r, now)) entry.unread += 1;
    if (r.observedAt >= since8w) entry.notes8w += 1;
  }
  for (const entry of out.values()) {
    entry.briefs.sort((a, b) => (newer(a, b) ? 1 : newer(b, a) ? -1 : 0));
  }
  return out;
}

const attributions = new WeakMap<perf.ComputedPerformance, Map<string, research.Attributed>>();

/** Python `attribution`: the window's attribution, cached on the performance computation. */
export function attribution(
  computed: perf.ComputedPerformance,
  window: string,
): research.Attributed | null {
  const days = research.SEGMENT_WINDOWS.get(window);
  if (days === undefined) return null;
  let cached = attributions.get(computed);
  if (cached === undefined) {
    cached = new Map();
    attributions.set(computed, cached);
  }
  let found = cached.get(window);
  if (found === undefined) {
    found = research.attributeWindow(computed, days);
    cached.set(window, found);
  }
  return found;
}

export interface SegmentsRequest {
  /** The vault's performance computation (`PerformanceService.computed`), ending on the view's day. */
  readonly computed: perf.ComputedPerformance;
  /** The device's price cache (watched instruments' bars). */
  readonly prices: market.PriceCache;
  readonly order?: market.PriceSourceOrder;
  readonly window?: string;
  readonly now: Instant;
  readonly lang: UiLang;
}

export type SegmentsResult =
  | { readonly ok: true; readonly value: research.SegmentsPayload }
  | { readonly ok: false; readonly reason: "unknown_window" };

/** Python `segments_view` (`GET /research/segments`). */
export function segmentsView(read: Read, req: SegmentsRequest): SegmentsResult {
  const window = req.window ?? research.DEFAULT_SEGMENT_WINDOW;
  const found = attribution(req.computed, window);
  if (found === null) return { ok: false, reason: "unknown_window" };
  const now = req.now;
  const watched = [...watchedInstrumentGids(read)] as InstrumentId[];
  const inputs = found.inputs;
  const missing = watched.filter((g) => !inputs.instruments.has(g));
  const extraInstruments = new Map<InstrumentId, Instrument>();
  for (const [g, inst] of loadInstruments(read, missing))
    extraInstruments.set(g as InstrumentId, inst);
  const unread = watched.filter((g) => !inputs.bars.has(g));
  const extraBars = new Map<InstrumentId, readonly PriceBar[]>();
  if (unread.length > 0) {
    const maxAge = inputs.policy.maxPriceAgeDays;
    const since = addDays(found.end, -(28 + maxAge + research.TREND_MARGIN_DAYS));
    const all = new Map([...inputs.instruments, ...extraInstruments]);
    const cached = market.cachedMarketData(
      req.prices,
      unread.flatMap((g) => all.get(g) ?? []),
      req.order === undefined ? {} : { order: req.order },
    );
    for (const g of unread) {
      const series = cached.series(g).filter((b) => since <= b.date && b.date <= found.end);
      if (series.length > 0) extraBars.set(g, series);
    }
  }
  const trends = research.topicTrends(found, watched, extraInstruments, extraBars);
  const facts = new Map<string, research.SegmentNoteFacts>();
  for (const [segment, n] of notesBySegment(read, now)) {
    facts.set(segment, {
      note: briefNote(n.latest),
      latestObserved: n.latest === undefined ? null : research.instantDate(n.latest.observedAt),
      unread: n.unread,
      notes8w: n.notes8w,
      lastNoteAt: n.newest === undefined ? null : iso(n.newest.observedAt),
      briefs: n.briefs.map((r) => topicBrief(r, now)),
      valuation: topicValuation(n.valuation),
    });
  }
  const theses = new Map<string, unknown>();
  for (const [segment, row] of topicThesesBySegment(read)) {
    theses.set(segment, topicThesisView(row, req.lang));
  }
  return {
    ok: true,
    value: research.segmentsPayload({
      window,
      found,
      trends,
      notes: facts,
      theses,
      week: research.isoWeek(research.instantDate(now)),
      isoWeekOf: research.isoWeek,
      lang: req.lang,
    }),
  };
}
