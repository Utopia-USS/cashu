import { LoansStartView } from "./LoansStartView.js";
import { privacyState, StoryFixture, storyState } from "./testing/storyState.js";
export default {
  title: "Desktop/Loans/Start",
  component: LoansStartView,
  render: (args: { state: Partial<import("./useLoansScreen.js").LoansState> }) => (
    <StoryFixture component={LoansStartView} state={args.state} />
  ),
  args: { state: storyState },
};
export const Ready = {};
export const Loading = {
  args: { state: { ...storyState, start: { ...storyState.start, steps: null } } },
};
export const Privacy = { args: { state: privacyState } };
