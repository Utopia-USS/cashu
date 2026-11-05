// The weekly review deck over the investments Home (ab24ab6 v2/ReviewDeck.tsx ReviewDeck): the Home mounts it
// while the review is open (`review=1`) and hands it the deck data it already holds (contract-R.md).
import { ReviewDeckView } from "./ReviewDeckView.js";
import { type ReviewDeckScreenProps, useReviewDeck } from "./useReviewDeck.js";

export function ReviewDeckScreen(props: ReviewDeckScreenProps) {
  return <ReviewDeckView state={useReviewDeck(props)} />;
}
