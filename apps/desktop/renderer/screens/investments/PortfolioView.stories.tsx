import { UiEnvProvider } from "@cashu/ui";
import { PortfolioView } from "./PortfolioView.js";
import { StoryFixture } from "./storyState.js";
import type { PortfolioScreenState } from "./usePortfolioScreen.js";
export default {
  title: "Desktop/Investments/Portfolio",
  component: PortfolioView,
  render: (args: { state: Partial<PortfolioScreenState> }) => (
    <StoryFixture component={PortfolioView} state={args.state} />
  ),
  args: { state: {} },
};
export const Ready = {};
export const Unavailable = {
  args: {
    state: {
      portfolio: { status: "unavailable", reason: "current_files_unavailable", accounts: [] },
    },
  },
};
export const Privacy = {
  args: { state: { privacy: true } },
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
