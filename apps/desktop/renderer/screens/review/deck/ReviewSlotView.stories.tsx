import { ReviewSlotView } from "./ReviewSlotView.js";

const slot = {
  label: "Weekly review · 6 cards",
  title: "Weekly review: 6 cards to review",
  due: true,
  badge: 6,
  onOpen() {},
  onUndo: null,
};
export default {
  title: "Desktop/Review/Slot",
  component: ReviewSlotView,
  args: { slot },
};
export const Due = {};
