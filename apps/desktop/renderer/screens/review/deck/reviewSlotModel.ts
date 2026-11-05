// The review's entry in the portfolio hero (ab24ab6 v2/ReviewDeck.tsx ReviewButton + Home.tsx `.rv-slot`): the
// button's accessible name and tooltip formatted here, so ReviewSlotView stays pure.
import { S } from "@cashu/i18n/investments/v2/ReviewDeck.strings";
import { dm } from "@cashu/ui-logic/investments/labels";

export interface ReviewSlotInput {
  /** `digest.review?.name`; null = the default "Przegląd tygodnia". */
  name: string | null;
  /** The review is due (`digest.review_due` unless it was marked done in this window). */
  due: boolean;
  /** The deck's card count (`data.live.cards.length`), the red badge while due. */
  count: number;
  /** When the last review was done (the local one first). */
  last: string | null;
  /** The next scheduled review day. */
  next: string | null;
  onOpen(): void;
  /** "cofnij" next to the button within the server's undo window after a review saved here; else null. */
  onUndo: (() => void) | null;
}
export interface ReviewSlotModel {
  label: string;
  title: string;
  due: boolean;
  /** The badge number, null without a badge. */
  badge: number | null;
  onOpen(): void;
  onUndo: (() => void) | null;
}

export function reviewSlotModel({
  name,
  due,
  count,
  last,
  next,
  onOpen,
  onUndo,
}: ReviewSlotInput): ReviewSlotModel {
  const title = name ?? S.weeklyReview;
  const done = last ? S.hdrDone(dm(last)) : null;
  return {
    label: due ? `${title} · ${S.hdrCards(count)}` : `${title} · ${done ?? S.hdrOpen}`,
    title: due
      ? `${title}: ${S.hdrCardsToReview(count)}`
      : `${title}${done ? ` · ${done}` : ""}${next ? ` · ${S.hdrNext(dm(next))}` : ""}`,
    due,
    badge: due && count > 0 ? count : null,
    onOpen,
    onUndo,
  };
}
