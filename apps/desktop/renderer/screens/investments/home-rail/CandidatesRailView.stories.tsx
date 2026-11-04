import { CandidatesRailView } from "./CandidatesRailView.js";

const args = {
  privacy: false,
  available: true,
  freshCount: 1,
  totalOpen: 1,
  rows: [
    {
      id: "candidate-1",
      tile: "ACM",
      name: "Synthetic company",
      sentence: "A synthetic headline about its entry criteria.",
      watched: false,
      busy: false,
      criteria: [{ text: "Synthetic criterion", met: true }],
      context: "Synthetic research context.",
      onWatch() {},
      onDismiss() {},
    },
  ],
  notice: null,
  onAll() {},
};

export default { title: "Desktop/Investments/CandidatesRail", component: CandidatesRailView, args };
export const Fresh = {};
export const Private = { args: { ...args, privacy: true } };
export const Unavailable = { args: { ...args, available: false } };
