// The data of the ported weekly review deck: ab24ab6 v2/ReviewDeck.tsx useReviewDeckData (lines 42-95) with the
// same inputs (minus slug / nonce) and the same result, its research reads served by the native research and
// signals queries (the shared entries the Home already holds). Plus the deck's writes mapped to native commands.
import { addDays } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { S } from "@cashu/i18n/investments/v2/ReviewDeck.strings";
import { researchScreenQueries } from "@cashu/store/investments/research-screen";
import {
  reviewPositionDecision,
  saveReview,
  undoSavedReview,
} from "@cashu/store/investments/review-screen";
import {
  conditionalOwnerAcknowledge,
  signalsOwnerCommands,
  signalsQueries,
  signalsSnooze,
} from "@cashu/store/investments/signals-screen";
import { useCommand, useQuery, useUiAction } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { label } from "@cashu/ui-logic/core/messages";
import { benchmarkLabel, changeSince, staleBenchmark } from "@cashu/ui-logic/investments/v2/logic";
import type { DigestResearch, ResearchNote } from "@cashu/ui-logic/investments/v2/research/types";
import {
  CARD_ORDER,
  type CardId,
  type DecideItem,
  type DecideRest,
  decideItems,
  decideSubjects,
  deckCards,
  openIdeas,
  type ProposalLike,
  sectorRows,
  type ThesisLite,
  topMovers,
  weekEvents,
  weeklySigma,
  worldVerdict,
} from "@cashu/ui-logic/investments/v2/reviewDeckLogic";
import type { DigestV2, Performance, SignalV2 } from "@cashu/ui-logic/investments/v2/types";
import { useCalendarDay } from "../../../shell/useCalendarDay.js";
import {
  allNotesOf,
  calendarOf,
  loaded,
  macroOf,
  newestThesesOf,
  researchNotes,
  runsOf,
  segmentsOf,
  summaryOf,
} from "../../investments/home/homeAdapters.js";
import { gidOf, legacyId } from "../../investments/home/legacyWire.js";
import {
  useResearchNoteActions,
  type WriteOutcome,
} from "../../investments/home/useInvestmentsHomeData.js";
import { dayReadInstant } from "../../signals/signalModels.js";
import { commandFailure, useDurableCommands } from "../../useDurableCommand.js";

const research = researchScreenQueries().screen;
const signalsQuery = signalsQueries().screen;

export type Verdict = "keep" | "flag";
/** What the deck sends with the review (ReviewDeck.tsx DeckStats; MCP research_context.owner_review). */
export interface DeckStats {
  cards: { id: CardId; verdict: Verdict }[];
  agenda: { card: CardId; title: string; note: string | null }[];
  decisions: { subject: string; choice: string }[];
  skipped: CardId[];
}

export interface ReviewDeckDataInput {
  digest: DigestV2 | null | undefined;
  perfWeek: Performance | null | undefined;
  perfYear: Performance | null | undefined;
  signals: SignalV2[];
  proposals: ProposalLike[];
  names: Map<number, string>;
  /** The deck is open: only then the calendar card's events are handed over (as the old request was). */
  open: boolean;
}

/** Everything the deck shows (ReviewDeck.tsx:42-95), so the review button can count the cards. */
export function useReviewDeckData({
  digest,
  perfWeek,
  perfYear,
  signals,
  proposals,
  names,
  open,
}: ReviewDeckDataInput) {
  const today = useCalendarDay();
  const { privacy } = useUiEnv();
  const language = lang();
  const researchRead = useQuery(research, { today, lang: language });
  const signalsRead = useQuery(signalsQuery, {
    now: dayReadInstant(today),
    today,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: language,
    privacy,
  });
  const since = digest?.since ?? null;
  // "New since the last review" counts from the review's exact time, not its day.
  const sinceAt = digest?.since_at ?? since;
  const segData = segmentsOf(researchRead);
  const seg = { data: segData, loading: false as const, failed: !segData };
  const macroData = macroOf(researchRead);
  const macro = { data: macroData, loading: false as const, failed: !macroData };
  const notes = allNotesOf(researchRead);
  const overview = {
    runs: runsOf(researchRead),
    summary: summaryOf(researchRead),
    candidates: researchNotes(notes, { kind: "candidate", include_dismissed: true }),
    loading: false as const,
  };
  const notesQ = {
    data: since ? researchNotes(notes, { since, limit: 200 }) : ([] as ResearchNote[]),
    error: null,
    loading: false as const,
  };
  const calRead = calendarOf(researchRead);
  const cal = open
    ? { ...calRead, error: calRead.error && (label(`error.${calRead.error}`) ?? calRead.error) }
    : loaded(null);
  // The theses of the Do decyzji subjects (their exit plan and when they fail), newest version per instrument.
  const digestResearch =
    (digest as { research?: DigestResearch | null } | null | undefined)?.research ?? null;
  const subjects = decideSubjects(signals, sinceAt, digestResearch).sort((a, b) => a - b);
  const theses: Map<number, ThesisLite> = newestThesesOf(signalsRead, subjects);
  const thesesQ = { data: theses, loading: false as const };
  const own = (digest?.review?.cards ?? []).filter((c): c is CardId =>
    (CARD_ORDER as string[]).includes(c),
  );
  const order = own.length ? own : CARD_ORDER;

  const week = changeSince(perfWeek?.points ?? [], since ?? "");
  const benchStale = staleBenchmark(perfWeek?.benchmark);
  const bench = benchStale ? null : week.bench;
  const sigma = weeklySigma(perfYear?.points ?? []);
  const verdict = worldVerdict(week.pct, bench, sigma);
  const ddNow = perfYear?.points.length
    ? (perfYear.points[perfYear.points.length - 1]?.drawdown ?? null)
    : null;
  const ddMax = perfYear?.summary?.max_drawdown?.depth ?? null;
  const sectors = sectorRows(seg.data);
  const movers = topMovers(seg.data, names);
  const events = weekEvents(notesQ.data);
  const macroChanges = digestResearch?.macro_changes ?? [];
  const ready = !!digest && perfWeek !== undefined && perfYear !== undefined;
  const d = decideItems(signals, digestResearch, names, proposals, {
    since: sinceAt,
    theses: thesesQ.data,
  });
  const ideas = openIdeas(overview.candidates);
  const { cards, skipped } = deckCards(
    { movers, sectors, events, macroChanges, decide: d.items, ideas },
    order,
  );
  // The home rail sorts the same subjects, snoozed ones included, into new and put off (railLogic.ts).
  const rail = decideItems(signals, digestResearch, names, [], {
    since: sinceAt,
    theses: thesesQ.data,
    includeSnoozed: true,
    lastReviewAt: digest?.last_review?.done_at ?? null,
    limit: Number.POSITIVE_INFINITY,
  });
  const live = {
    cards,
    skipped,
    decide: d.items,
    more: d.more,
    rest: d.rest,
    ideas,
    rail: rail.items,
    railRest: rail.rest,
  };
  return {
    seg,
    macro,
    research: overview,
    notesQ,
    cal,
    digestResearch,
    week,
    benchStale,
    bench,
    sigma,
    verdict,
    ddNow,
    ddMax,
    sectors,
    movers,
    events,
    macroChanges,
    ready,
    live,
    /** The bench row's label (`benchmarkLabel(perfWeek.benchmark)`), formatted here for the pure View. */
    benchLabel: benchmarkLabel(perfWeek?.benchmark),
    /** The note sheet's lookup (ReviewDeck.tsx openNote): every note, dismissed and expired included. */
    allNotes: notes,
  };
}
export type ReviewDeckData = ReturnType<typeof useReviewDeckData>;
export type { DecideItem, DecideRest };

/** The deck's writes (ReviewDeck.tsx decide / Home.tsx markDone + undo) on the native commands. Each answers null
 * when it went through, else the old toast's message; the live queries carry the readback. */
export function useReviewDeckCommands() {
  const today = useCalendarDay();
  const durable = useDurableCommands();
  const snooze = useUiAction(signalsSnooze);
  const acknowledge = useCommand(conditionalOwnerAcknowledge);
  const position = useCommand(reviewPositionDecision);
  const decideOne = useCommand(signalsOwnerCommands.decide);
  const save = useCommand(saveReview);
  const undo = useCommand(undoSavedReview);
  const notes = useResearchNoteActions();

  const failedWith = (message: string) => S.decisionFailed(message);
  const gids = (ids: readonly number[]) =>
    ids.flatMap((id) => {
      const gid = gidOf(id);
      return gid === null ? [] : [gid];
    });

  /** One Do decyzji answer (ReviewDeck.tsx decide, the write part): snooze 7 days, acknowledge, one position
   * decision linking every open signal of the subject, or a decision on the single signal. Proposals and
   * theses stay local to the deck as before. */
  const decide = async (item: DecideItem, action: string): Promise<WriteOutcome> => {
    const ids = gids(item.signalIds ?? []);
    if (action === "snooze") {
      const until = addDays(today, 7);
      for (const signal of ids) {
        const r = await snooze.run({ signal, until });
        if (r.status !== "completed") return failedWith(label(`error.${r.reason}`) ?? r.reason);
      }
      return null;
    }
    if (action === "ack") {
      for (const signal of ids) {
        const r = await durable.run(`ack:${signal}`, acknowledge, { signal, reason: null });
        if (r.kind !== "completed") return failedWith(commandFailure(r));
      }
      return null;
    }
    const decision = action as "bought" | "sold" | "held" | "ignored" | "other";
    const instrument = gidOf(item.instrumentId ?? null);
    if (instrument !== null) {
      const r = await durable.run(`position:${item.key}`, position, {
        instrument,
        signals: ids,
        action: decision,
        reason: S.decisionReason,
      });
      return r.kind === "completed" ? null : failedWith(commandFailure(r));
    }
    const first = ids[0];
    if (first === undefined) return null;
    const r = await durable.run(`decide:${first}`, decideOne, {
      signal: first,
      action: decision,
      reason: S.decisionReason,
    });
    return r.kind === "completed" ? null : failedWith(commandFailure(r));
  };

  /** "Zamknij przegląd" (Home.tsx markDone): the review with the deck's cards, agenda, decisions and skipped
   * cards. `skipped` carries the reasons the deck showed (`built.skipped`). */
  const markDone = async (input: {
    deck: DeckStats;
    skipped: { id: CardId; why: string }[];
    notes: string;
    startedAt: number | null;
  }): Promise<{ id: number; done_at: string } | { error: string }> => {
    const minutes = input.startedAt
      ? Math.max(1, Math.round((Date.now() - input.startedAt) / 60000))
      : 0;
    const r = await durable.run("review:finish", save, {
      notes: input.notes.trim() || null,
      session: {
        cards: input.deck.cards,
        agenda: input.deck.agenda.map((a) => ({ card: a.card, note: a.note })),
        decisions: input.deck.decisions,
        skipped: input.skipped.map((s) => ({ id: s.id, reason: s.why })),
        minutes,
      },
    });
    if (r.kind !== "completed") return { error: commandFailure(r) };
    return { id: legacyId(r.value.review), done_at: r.value.savedAt };
  };

  /** The review undo within the 15 minutes (`DELETE /reviews/{id}`). */
  const undoReview = async (id: number): Promise<WriteOutcome> => {
    const review = gidOf(id);
    if (review === null) return label("error.not_found") ?? "not_found";
    const r = await durable.run(`review:undo:${review}`, undo, { review });
    return r.kind === "completed" ? null : commandFailure(r);
  };

  return {
    decide,
    markDone,
    undoReview,
    /** The Okazje card's Obserwuj / Nie interesuje mnie (research/data.ts useResearchActions). */
    watch: notes.watch,
    dismiss: notes.dismiss,
    noteBusy: notes.busy,
    busy:
      snooze.isPending ||
      acknowledge.isPending ||
      position.isPending ||
      decideOne.isPending ||
      save.isPending ||
      undo.isPending,
  };
}
export type ReviewDeckCommands = ReturnType<typeof useReviewDeckCommands>;
