import { UiEnvProvider } from "@cashu/ui";
import { LoansView } from "./LoansView.js";
import { StoryFixture, storyState } from "./storyState.js";
export default {
  title: "Desktop/Loans/Loans",
  component: LoansView,
  render: (args: { state: Partial<import("./useLoansScreen.js").LoansState> }) => (
    <StoryFixture component={LoansView} state={args.state} />
  ),
  args: { state: storyState },
};
export const Ready = {};
export const Empty = { args: { state: { ...storyState, rows: [], current: null } } };
export const Privacy = {
  args: { state: { ...storyState, privacy: true } },
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={true}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
