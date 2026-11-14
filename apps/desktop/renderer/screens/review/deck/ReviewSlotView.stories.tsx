import { ReviewSlotView } from "./ReviewSlotView.js";
import type { ReviewSlotModel } from "./reviewSlotModel.js";

const slot: ReviewSlotModel = {
  name: "Weekly review",
  label: "Weekly review · 6 items to decide · 9 cards",
  title: "Weekly review: 9 cards to review",
  due: true,
  badge: 6,
  pop: {
    title: "6 items to decide",
    rows: [
      { key: "risk", tone: "negative", text: "4 risks" },
      { key: "chance", tone: "positive", text: "1 opportunity" },
      { key: "fix", tone: "warning", text: "1 to fix" },
      { key: "plan", tone: "info", text: "1 in progress, not counted", dim: true },
    ],
    when: "Due now · last review 31.10",
  },
  onOpen() {},
  onUndo: null,
};
export default {
  title: "Desktop/Review/Slot",
  component: ReviewSlotView,
  args: { slot },
};
export const Due = {};
export const PopoverOpen = { args: { slot, open: true } };
export const Done = {
  args: {
    slot: {
      ...slot,
      label: "Weekly review · done 2.11",
      title: "Weekly review · done 2.11 · next 9.11",
      due: false,
      badge: null,
      pop: { title: "Nothing to decide", rows: [], when: "Next on 9.11 · last review 2.11" },
      onUndo() {},
    },
  },
};
