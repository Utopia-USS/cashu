import { LoanDrawerView } from "./LoanDrawerView.js";
import { StoryFixture, storyState } from "./testing/storyState.js";

const open = { ...storyState, drawer: { kind: "loan" as const } };
export default {
  title: "Desktop/Loans/New loan",
  component: LoanDrawerView,
  render: (args: { state: Partial<import("./useLoansScreen.js").LoansState> }) => (
    <StoryFixture component={LoanDrawerView} state={args.state} />
  ),
  args: { state: open },
};
export const Ready = {};
export const Invalid = {
  args: {
    state: {
      ...open,
      err: "Synthetic refusal",
      loan: { ...open.loan, errors: { name: "Synthetic field error" } },
    },
  },
};
export const Pending = { args: { state: { ...open, busy: true } } };
