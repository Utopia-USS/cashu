import { D } from "@cashu/domain";
import type { views } from "@cashu/domain/investments";
import { type ReadyReview, reviewNotesSchema } from "@cashu/store/investments/review-screen";
import { useUiEnv } from "@cashu/ui";
import { useForm } from "@tanstack/react-form";
import { z } from "zod";
import {
  presentReviewIdea,
  presentReviewItem,
  reviewDisplayDates,
  reviewRiskMacro,
} from "./presentation.js";
import { startSession } from "./session.js";
import type { ReviewScreenState } from "./useReviewScreen.js";

const now = "2026-10-31T12:00:00Z";
const note = {
  id: "00000000-0000-8000-8000-000000000111",
  title: "Synthetic research update",
  summary: "Synthetic complete research prose.\n\nA second paragraph remains available.",
  observed_at: now,
  expires_at: "2026-11-30T00:00:00Z",
  sources: [
    { title: "Synthetic source", url: "https://example.com/source", publisher: "Synthetic" },
  ],
  dismissed: false,
  candidate: null,
  kind: "news",
};
/** Synthetic stories intentionally specify the transport fields rendered by this View. */
export function storySnapshot(long = false): ReadyReview {
  return {
    status: "current",
    vault: "5f0c3a9e81d24b7690ae13c7d2f4b856",
    revision: "synthetic",
    now,
    today: "2026-10-31",
    name: "Synthetic review",
    due: true,
    last: null,
    next: "2026-11-07",
    hasData: true,
    cards: ["world", "sectors", "positions", "events", "ideas", "calendar", "decide"],
    skipped: [],
    digest: {
      since: "2026-10-24",
      as_of: "2026-10-31",
      value: { currency: "PLN", now: D("1000"), change: D("23") },
    },
    world: {
      move: 0.023,
      benchmark: 0.01,
      benchmarkStale: false,
      sigma: 0.019,
      verdict: { size: "strong", vs: "better", down: false },
      drawdown: -0.03,
      maxDrawdown: -0.08,
    },
    sectors: [
      {
        key: "equity_global",
        label: "Global equities",
        contribution: 0.023,
        ret: 0.04,
        weight: 0.6,
        currency: false,
        briefs: [],
      },
    ],
    sectorVerdict: { code: "all_plus", names: ["Global equities"], share: null, down: false },
    movers: {
      down: [{ id: "synthetic-down", label: "Synthetic down", ret: -0.04, contribution: -0.01 }],
      up: [{ id: "synthetic-up", label: "Synthetic up", ret: 0.06, contribution: 0.03 }],
      all: Array.from({ length: long ? 120 : 2 }, (_, i) => ({
        id: `synthetic-${i}`,
        label: `Synthetic position ${i + 1}`,
        ret: 0.04,
        contribution: 0.001,
      })),
    },
    events: [{ note, score: 3 }],
    ideas: [
      {
        ...note,
        id: "00000000-0000-8000-8000-000000000112",
        kind: "candidate",
        candidate: { name: "Synthetic candidate", symbol: "SYN" },
      },
    ],
    decide: {
      items: [
        {
          key: "subject",
          kind: "subject",
          group: "risk",
          instrument: "synthetic-instrument",
          title: "Synthetic position",
          why: "Synthetic observed fact",
          facts: ["Synthetic supporting fact"],
          signals: ["synthetic-signal"],
          note: null,
          proposal: null,
          thesis: "Synthetic owner thesis",
          invalidation: "Synthetic invalidation",
          exitPlan: "Synthetic exit plan",
        },
      ],
      more: 0,
      rest: { review: 0, research: 0 },
    },
    macro: { status: "unavailable", reason: "source_unbound" },
    macroChanges: [],
    riskBrief: null,
    sectorBriefs: [],
    candidateStates: [],
    briefs: [],
    research: { macro_changes: [] },
    sources: {
      macro: { status: "unavailable", reason: "source_unbound" },
      segments: { status: "current" },
    },
    calendar: {
      status: "current",
      value: {
        as_of: "2026-10-31",
        from: "2026-10-31",
        to: "2026-11-14",
        fetched_at: now,
        stale: false,
        errors: [],
        events: [
          {
            date: "2026-11-03",
            time: null,
            kind: "macro",
            title: "Synthetic macro event",
            country: "US",
            country_label: "United States",
            instrument_id: null,
            label: null,
            held: null,
            note_id: null,
          },
        ],
      },
    },
  } as unknown as ReadyReview;
}
export function useStoryState(
  card: views.ReviewCardId | "summary",
  long = false,
  availability?: "empty" | "unavailable" | "error",
): ReviewScreenState {
  const { privacy } = useUiEnv();
  const base = storySnapshot(long);
  const snapshot: ReadyReview =
    availability === "empty" && base.calendar.status === "current"
      ? { ...base, calendar: { status: "current", value: { ...base.calendar.value, events: [] } } }
      : availability === "unavailable" || availability === "error"
        ? {
            ...base,
            calendar: {
              status: availability,
              reason: availability === "error" ? "calendar_projection_failed" : "source_unbound",
            },
          }
        : base;
  const session = {
    ...startSession(snapshot),
    index: card === "summary" ? 7 : snapshot.cards.indexOf(card),
    verdicts: { world: "flag" as const },
    notes: { world: "Synthetic agent agenda" },
  };
  const form = useForm({
    defaultValues: { closing: "" },
    validators: { onChange: z.object({ closing: reviewNotesSchema }) },
  });
  return {
    data: snapshot,
    privacy,
    session,
    verdictRows: snapshot.cards.map((id) => ({ id, verdict: "keep" })),
    agenda: [{ card: "world", note: "Synthetic agent agenda" }],
    skips: [],
    chosen: [],
    dates: reviewDisplayDates(snapshot),
    items: snapshot.decide.items.map(presentReviewItem),
    ideas: snapshot.ideas.map(presentReviewIdea),
    riskMacro: reviewRiskMacro(snapshot),
    card,
    detail: true,
    setDetail() {},
    noteOpen: false,
    setNoteOpen() {},
    saveCardNote() {},
    suspended: false,
    reader: null,
    setReader() {},
    notice: null,
    pending: null,
    unknownItems: new Set(),
    candidateChoices: {},
    advance() {},
    back() {},
    choose: async () => {},
    candidate: async () => {},
    save: async () => {},
    form,
    onClosed() {},
  };
}
