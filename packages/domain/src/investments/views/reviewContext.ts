/** Shared unlabelled review deck context. MCP privacy labels belong to the later surface adapter. */

import type { UiLang } from "../../core/i18n.js";
import { utcIso } from "../../dates.js";
import type { CalendarView } from "../market/index.js";
import type { StrategyConfig } from "../strategy/index.js";
import {
  type LastReviewFact,
  type ReviewClock,
  reviewPolicyView,
  reviewSinceDay,
} from "./reviewSchedule.js";

export const CARD_GUIDE = {
  world: "history_metrics / portfolio_overview for the move, research_context.macro for why",
  sectors: "research_context.segments (contribution_1w, return_1w, briefs)",
  positions: "research_context.segments[].instruments (return_1w, contribution_1w)",
  events: "research_notes(since) with strength >= 2 or a thesis relation",
  decide: "signals (open, undecided), theses, pending proposals in profile_overview",
  ideas: "research_context.candidates.open",
  calendar: "calendar.events of this tool",
} as const;

function agenda(last: LastReviewFact | null): readonly { card: unknown; note: unknown }[] {
  const deck = last?.stats.deck;
  if (deck === null || typeof deck !== "object" || Array.isArray(deck)) return [];
  const items = (deck as Readonly<Record<string, unknown>>).agenda;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? [
          {
            card: (item as Record<string, unknown>).card ?? null,
            note: (item as Record<string, unknown>).note ?? null,
          },
        ]
      : [],
  );
}

export function reviewContextView(input: {
  readonly config: StrategyConfig | null;
  readonly clock: ReviewClock;
  readonly lang: UiLang;
  readonly lastReview: LastReviewFact | null;
  /** Null is the documented unavailable/error calendar state, not a fabricated successful fetch. */
  readonly calendar: CalendarView | null;
}) {
  const last = input.lastReview;
  return {
    review: reviewPolicyView(input.config, input.clock, last, input.lang),
    since: reviewSinceDay(input.clock, last),
    last_review:
      last === null
        ? null
        : { done_at: utcIso(last.doneAt), notes: last.notes, agenda: agenda(last) },
    card_sources: { ...CARD_GUIDE },
    calendar: {
      stale: input.calendar?.stale ?? true,
      events: (input.calendar?.events ?? []).map((event) => ({
        date: event.date,
        time: event.time,
        kind: event.kind,
        title: event.title,
        country: event.country_label,
        instrument_id: event.instrument_id,
        label: event.label,
        held: event.held,
      })),
    },
  };
}
