import { ReviewDeckView } from "./ReviewDeckView.js";
import type { ReviewDeckState } from "./useReviewDeck.js";

const none = () => {};
// The deck while it is being built (the minimal state the story guard needs).
const state: ReviewDeckState = {
  title: "Weekly review",
  heading: "Weekly review",
  sub: "Weekly review · 26.10 - 2.11",
  built: false,
  index: 0,
  dots: [],
  stack: [],
  flying: null,
  showButtons: false,
  canUndo: false,
  suspended: false,
  busy: false,
  closing: "",
  sheet: null,
  onClose: none,
  onEscape: none,
  onUndo: none,
  onAdvance: none,
  onDetail: none,
  onToggleNote: none,
  onCardNote: none,
  onOpenNote: none,
  onSheetClosed: none,
  onDecide: none,
  onWatch: none,
  onDismiss: none,
  onClosing: none,
  onFinish: none,
  onKey: () => false,
};
export default {
  title: "Desktop/Review/Deck",
  component: ReviewDeckView,
  args: { state },
};
export const Building = {};
