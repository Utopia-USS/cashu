import { AssetResearchView } from "./AssetResearchView.js";
import { assetResearchModel } from "./assetResearchModel.js";

const noop = () => {};
const model = assetResearchModel(
  {
    instrumentId: 1,
    held: true,
    thesis: null,
    notes: [],
    summary: null,
    runs: [],
    today: "2026-11-05",
  },
  { older: false, openId: null, highlightId: null, now: 0 },
);

export default {
  title: "Desktop/Investments/AssetResearch",
  component: AssetResearchView,
  args: {
    model,
    ui: { onToggleOlder: noop, onToggleNote: noop, onDismiss: noop, onRestore: noop },
  },
};
export const NeverRan = {};
