import { LoanDrawerView } from "./LoanDrawerView.js";
import { StoryFixture, storyState } from "./storyState.js";
export default {
  title: "Desktop/Loans/New loan",
  component: LoanDrawerView,
  render: (args: { state: Partial<import("./useLoansScreen.js").LoansState> }) => (
    <StoryFixture component={LoanDrawerView} state={args.state} />
  ),
  args: { state: { ...storyState, drawer: "loan" as const } },
};
export const Ready = {};
export const Invalid = {
  args: { state: { ...storyState, drawer: "loan" as const, error: "Synthetic refusal" } },
};
export const Pending = { args: { state: { ...storyState, drawer: "loan" as const, busy: true } } };
export const Privacy = { args: { state: { ...storyState, privacy: true } } };
