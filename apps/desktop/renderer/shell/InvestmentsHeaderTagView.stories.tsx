import { InvestmentsHeaderTagView } from "./InvestmentsHeaderTagView.js";

/** Synthetic presentation fixture only. */
export default {
  title: "Shell/InvestmentsHeaderTag",
  component: InvestmentsHeaderTagView,
  args: {
    state: {
      tag: {
        text: "2 stale prices",
        title: "Synthetic A: last quote 30.10\nSynthetic B: no quotes",
      },
      onOpen: () => {},
    },
  },
};
export const Stale = {};
export const Fresh = { args: { state: { tag: null, onOpen: () => {} } } };
