import { LoansStartView } from "./LoansStartView.js";
import { StoryFixture, storyState } from "./storyState.js";
export default {
  title: "Desktop/Loans/Start",
  component: LoansStartView,
  render: (args: { state: Partial<import("./useLoansScreen.js").LoansState> }) => (
    <StoryFixture component={LoansStartView} state={args.state} />
  ),
  args: { state: storyState },
};
export const Ready = {};
export const Empty = { args: { state: { ...storyState, rows: [], current: null } } };
export const Privacy = { args: { state: { ...storyState, privacy: true } } };
