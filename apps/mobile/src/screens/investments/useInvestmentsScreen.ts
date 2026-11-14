// The Investments tab's shell: the header (prices fetched by this phone), the weekly review slot from the
// review query and the top tabs with the count of signals waiting for a decision. The sections
// (Portfolio, Signals, Strategy) are their own hooks; the route renders the current one inside.
import { addDays, type IsoDate } from "@cashu/domain";
import { undoSavedReview } from "@cashu/store/investments/review-screen";
import { useCommand, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import { useServices } from "../../services/ServicesProvider";
import { useNow } from "../../shell/useNow";
import { useTabChrome } from "../../shell/useTabChrome";
import { dayMonth, dayRange, instantOf, uiLang, weekdayDayMonth, weekdayName } from "./format";
import { S } from "./Investments.strings";
import type {
  InvestmentsViewName,
  InvestmentsViewProps,
  ReviewSlot,
} from "./investments-contracts";
import { decisionsWaiting, useInvestmentSignals } from "./useInvestmentSignals";

/** `undoSavedReview`'s window (`REVIEW_UNDO_WINDOW_MS`, 15 minutes). */
const UNDO_MS = 15 * 60_000;

type ReviewResult = ReturnType<
  ReturnType<typeof useServices>["moneyQueries"]["investments"]["review"]["run"]
>;
type CurrentReview = Extract<ReviewResult, { status: "current" }>;

/** The cards the deck will show: the screen's ids without the skipped ones, the calendar only with data. */
function deckCards(review: CurrentReview): readonly string[] {
  const skipped = new Set(review.skipped.map((s) => s.id));
  return review.cards.filter(
    (id) => !skipped.has(id) && (id !== "calendar" || review.calendar.status === "current"),
  );
}

/** The flagged cards of the last saved session (they wait on the Mac's agenda). */
function agendaOf(last: CurrentReview["last"]): number {
  const session = last?.stats.session;
  if (typeof session !== "object" || session === null) return 0;
  const agenda = (session as { agenda?: unknown }).agenda;
  return Array.isArray(agenda) ? agenda.length : 0;
}

function teaser(review: CurrentReview): string | null {
  const parts: string[] = [];
  const verdict = review.world?.verdict;
  if (verdict && verdict.size !== null) {
    const week = verdict.size === "calm" ? S.weekFlat : verdict.down ? S.weekDown : S.weekUp;
    const vs =
      verdict.vs === "worse"
        ? S.vsWorse
        : verdict.vs === "better"
          ? S.vsBetter
          : verdict.vs === "inline"
            ? S.vsInline
            : null;
    parts.push(vs === null ? week : `${week}, ${vs}`);
  }
  const decide = review.decide.items.length;
  if (decide > 0) parts.push(S.decisionsWaiting(decide));
  if (review.ideas.length > 0) parts.push(S.ideasOutside(review.ideas.length));
  if (parts.length === 0) return null;
  const text = parts.join(", ");
  return `${text.charAt(0).toLocaleUpperCase()}${text.slice(1)}.`;
}

function reviewSlot(review: ReviewResult, today: IsoDate, locale: string): ReviewSlot | null {
  if (review.status !== "current") return null;
  // The query's own moment: it re-runs when a review is saved, so a fresh save opens the undo window;
  // a stale "Undo" is refused by the command (`undo_expired`).
  const nowMs = Date.parse(review.now);
  if (review.due) {
    const next = review.next as IsoDate;
    const due =
      next === today
        ? S.dueToday
        : next < today
          ? S.dueSince(dayMonth(next, locale))
          : S.dueOn(weekdayName(next, locale));
    const to = next < today ? today : next;
    return {
      kind: "due",
      title: review.name,
      meta: S.reviewMeta(dayRange(addDays(to, -6), to, locale), deckCards(review).length, due),
      teaser: teaser(review),
    };
  }
  const waiting = agendaOf(review.last);
  const doneAt = review.last === null ? null : instantOf(review.last.doneAt).getTime();
  return {
    kind: "done",
    sub:
      waiting > 0
        ? S.cardsWaitOnMac(waiting)
        : S.nextOn(weekdayDayMonth(review.next as IsoDate, locale)),
    canUndo: doneAt !== null && nowMs - doneAt < UNDO_MS,
  };
}

export function useInvestmentsScreen(args: {
  readonly view: InvestmentsViewName;
  readonly onViewChanged: (view: InvestmentsViewName) => void;
  readonly openReview: () => void;
  readonly openProfile: () => void;
}): Omit<InvestmentsViewProps, "children"> {
  const { locale } = useUiEnv();
  const { moneyQueries } = useServices();
  const { today } = useNow();
  const header = useTabChrome({ fresh: "prices", openProfile: args.openProfile });
  const signals = useInvestmentSignals();
  const review = useQuery(moneyQueries.investments.review, {
    today,
    lang: uiLang(locale),
    open: false,
  });
  const undo = useCommand(undoSavedReview);
  const last = review.status === "current" ? review.last : null;
  return {
    header,
    view: args.view,
    signalsCount: decisionsWaiting(signals),
    review: reviewSlot(review, today, locale),
    onViewChanged: args.onViewChanged,
    onReviewPressed: args.openReview,
    onReviewUndo: () => (last === null ? undefined : undo.run({ review: last.gid })),
  };
}
