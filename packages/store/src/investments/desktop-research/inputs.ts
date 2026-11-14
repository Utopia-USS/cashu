import { toStorage, toUtc } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import { asProfileId, market, type views } from "@cashu/domain/investments";
import * as macro from "@cashu/domain/investments/macro";
import * as perf from "@cashu/domain/investments/performance";
import * as research from "@cashu/domain/investments/research";
import type { Read } from "../../query.js";
import { investmentPositionDto } from "../desktop/sources.js";
import type { MarketInput } from "../marketInput.js";
import { performanceInputs } from "../performance/inputs.js";
import { watchedInstrumentGids } from "../queries/alerts.js";
import { loadInstruments } from "../queries/instruments.js";
import { heldInstrumentGids, latestRun, notes, topicThesesBySegment } from "../research/queries.js";
import { type ResearchNote, viewInstant } from "../research/rows.js";
import { attribution, macroBrief, notesBySegment, segmentsView } from "../research/segments.js";
import { topicThesisView } from "../research/topics.js";
import {
  notesView,
  researchDigest,
  researchSummary,
  runsView,
  thesesByInstrument,
} from "../research/views.js";
import type { StrategyState } from "../services/strategy.js";
import type { PortfolioViewRequest } from "../views/portfolio.js";
import { readPositions } from "../views/positions.js";
import {
  performanceStrategy,
  type ResearchSourceResult,
  type ResearchSourceStatus,
  sourceStatus,
} from "./sources.js";

export type ResearchInputsRequest = MarketInput & {
  readonly vault: string;
  readonly clock: views.ViewClock;
  readonly strategy: StrategyState;
  readonly lang: UiLang;
  readonly macro: ResearchSourceResult<macro.MacroCloses>;
  readonly calendar: ResearchSourceResult<market.CalendarFeeds>;
};

export type ResearchSegmentProjection =
  | {
      readonly status: "current";
      readonly value: research.SegmentsPayload;
      readonly trends: research.Trends;
    }
  | { readonly status: "unavailable" | "error"; readonly reason: string };

export interface ResearchDigestProjection {
  readonly value: ReturnType<typeof researchDigest>;
  readonly macro: ResearchSourceStatus;
  readonly segments: ResearchSourceStatus;
}

/** Native note DTO adds genuine venue from the canonical vault instrument gid. */
export function nativeResearchNotes(
  read: Read,
  rows: readonly ResearchNote[],
  now: research.Instant,
  lang: UiLang,
) {
  const projected = notesView(read, rows, now, lang);
  const gids = new Set(
    projected.flatMap((note) => (note.instrument_id ? [note.instrument_id] : [])),
  );
  const instruments = loadInstruments(read, gids);
  return projected.map((note) => {
    const instrument = note.instrument_id ? instruments.get(note.instrument_id) : undefined;
    return {
      ...note,
      instrument:
        note.instrument && instrument
          ? { ...note.instrument, mic: instrument.mic }
          : note.instrument,
    };
  });
}

/** Minimal tracked read for Review and Research digest/attribution. */
export function readResearchDigestInputs(
  read: Read,
  request: ResearchInputsRequest,
  prepared?: perf.ComputedPerformance | null,
) {
  const now = viewInstant(toStorage(request.clock.now));
  let computed: perf.ComputedPerformance | null = prepared ?? null;
  if (prepared === undefined) {
    try {
      computed = perf.computePerformance(
        performanceInputs(read, {
          ...request,
          asOf: request.clock.today,
          strategy: performanceStrategy(request.strategy),
        }),
        request.clock.today,
      );
    } catch {
      computed = null;
    }
  }
  const segmentCache = new Map<"1w" | "4w", ResearchSegmentProjection>();
  const segments = (window: "1w" | "4w"): ResearchSegmentProjection => {
    const cached = segmentCache.get(window);
    if (cached) return cached;
    let result: ResearchSegmentProjection;
    if (computed === null) result = { status: "unavailable", reason: "performance_unavailable" };
    else {
      try {
        const projected = segmentsView(read, {
          ...request,
          computed,
          now,
          lang: request.lang,
          window,
        });
        result = projected.ok
          ? { status: "current", value: projected.value, trends: projected.trends }
          : { status: "unavailable", reason: projected.reason };
      } catch {
        result = { status: "error", reason: "segment_projection_failed" };
      }
    }
    segmentCache.set(window, result);
    return result;
  };
  const digest = (since: research.Instant | null): ResearchDigestProjection => {
    const week = segments("1w");
    let macroChanges: ReturnType<typeof macro.macroChanges> | undefined;
    if (request.macro.status === "current") {
      try {
        const start =
          since === null
            ? research.instantDate(now - 7n * research.MICROS_PER_DAY)
            : research.instantDate(since);
        const asOf = toUtc(request.clock.now).date;
        macroChanges = macro.macroChanges(
          macro.evaluate(request.macro.value, request.clock.today),
          start < asOf ? start : asOf,
          request.clock.today,
          request.lang,
        );
      } catch {
        macroChanges = undefined;
      }
    }
    return {
      value: researchDigest(read, {
        now,
        since,
        ...(week.status === "current" ? { segments: research.digestSegments(week.value) } : {}),
        ...(macroChanges === undefined ? {} : { macroChanges }),
      }),
      macro:
        macroChanges === undefined && request.macro.status === "current"
          ? { status: "error", reason: "macro_projection_failed" }
          : sourceStatus(request.macro),
      segments: sourceStatus(week),
    };
  };
  return { computed, segments, digest };
}

/** One tracked, synchronous read. Never retain this object across an await. */
export function readResearchInputs(
  read: Read,
  request: ResearchInputsRequest,
  prepared?: perf.ComputedPerformance | null,
) {
  const now = viewInstant(toStorage(request.clock.now));
  const { computed, segments, digest } = readResearchDigestInputs(read, request, prepared);
  const portfolioRequest: PortfolioViewRequest = {
    ...request,
    vault: asProfileId(request.vault),
    asOf: request.clock.today,
    forOwner: true,
    accounts: null,
  };
  const positionResult = readPositions(read, portfolioRequest);
  const positions = positionResult.ok
    ? positionResult.value.positions.map(investmentPositionDto)
    : [];
  const weights = new Map(positions.map((row) => [row.instrument.id, row.weight]));
  const summary = positionResult.ok
    ? {
        status: "current" as const,
        value: researchSummary(read, { now, lang: request.lang, weights }),
      }
    : { status: "unavailable" as const, reason: positionResult.reason };
  const rows = notes(read, now, { includeDismissed: true, includeExpired: true });
  const noteViews = nativeResearchNotes(read, rows, now, request.lang);
  const freshFrom = research.instantDate(now - 7n * research.MICROS_PER_DAY);
  const candidateRail = noteViews
    .filter(
      (note) =>
        note.kind === "candidate" &&
        !note.dismissed &&
        !note.expired &&
        !note.candidate?.accepted_at,
    )
    .map((note, index) => ({ note, index }))
    .sort((a, b) => {
      const rank = (note: typeof a.note) =>
        note.watched ? 2 : (note.observed_at ?? "").slice(0, 10) >= freshFrom ? 0 : 1;
      return (
        rank(a.note) - rank(b.note) ||
        (b.note.observed_at ?? "").localeCompare(a.note.observed_at ?? "") ||
        a.index - b.index
      );
    })
    .slice(0, 3)
    .map(({ note }) => note);
  const runViews = runsView(read, now);
  const theses = [...thesesByInstrument(read)].map(([instrument, thesis]) => ({
    instrument,
    thesis,
  }));
  const topics = [...topicThesesBySegment(read)].map(([key, thesis]) => ({
    key,
    thesis: topicThesisView(thesis, request.lang),
  }));
  const macroRegimes =
    request.macro.status === "current"
      ? (() => {
          try {
            const projected = segments("1w");
            const attributed =
              computed === null || projected.status !== "current"
                ? null
                : attribution(computed, "1w");
            const effect =
              attributed === null ? null : macro.currencyEffectOf(attributed.attribution);
            const briefs = notesBySegment(read, now);
            return {
              status: "current" as const,
              value: macro.evaluate(request.macro.value, request.clock.today).map((r) => ({
                ...macro.regimeDict(r, request.lang, effect),
                brief: macroBrief(
                  macro.currentBrief(briefs.get(research.macroKey(r.key))?.briefs ?? [], r) ??
                    undefined,
                  now,
                ),
              })),
            };
          } catch {
            return { status: "error" as const, reason: "macro_projection_failed" };
          }
        })()
      : request.macro;
  const calendar: ResearchSourceResult<market.CalendarView> =
    request.calendar.status === "current"
      ? (() => {
          try {
            const held = heldInstrumentGids(read, request.clock.today);
            const watched = watchedInstrumentGids(read);
            const instruments = [
              ...loadInstruments(read, new Set([...held, ...watched])).values(),
            ].map((inst) => ({
              id: inst.id,
              name: inst.name,
              symbol: inst.symbol,
              mic: inst.mic,
              label: inst.name,
              yahoo: inst.aliases.find((a) => a.namespace === "yahoo")?.value ?? null,
              held: held.has(inst.id),
            }));
            const calendarNotes = rows.map((row) => ({
              id: row.gid,
              kind: row.kind,
              title: row.title,
              instrumentId: row.instrument,
              segment: row.segment,
              details: row.details,
            }));
            return {
              status: "current" as const,
              value: market.calendarEvents({
                feeds: request.calendar.value,
                stale:
                  market.isStale(request.calendar.value) ||
                  !market.isFresh(
                    request.calendar.value,
                    request.clock.today,
                    14,
                    request.clock.now,
                  ),
                today: request.clock.today,
                days: 14,
                instruments,
                notes: calendarNotes,
                lang: request.lang,
              }),
            };
          } catch {
            return { status: "error" as const, reason: "calendar_projection_failed" };
          }
        })()
      : request.calendar;
  return {
    computed,
    positions,
    positionStatus: positionResult.ok
      ? { status: "current" as const }
      : { status: "unavailable" as const, reason: positionResult.reason },
    summary,
    notes: noteViews,
    candidateRail,
    runs: runViews,
    lastRun: latestRun(read)?.gid ?? null,
    theses,
    topics,
    segments,
    macro: macroRegimes,
    calendar,
    digest,
  };
}

export type ResearchInputs = ReturnType<typeof readResearchInputs>;
