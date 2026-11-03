import { AssetDetailView } from "./AssetDetailView.js";
import { StoryFixture } from "./storyState.js";
import type { PortfolioScreenState } from "./usePortfolioScreen.js";
export default {
  title: "Desktop/Investments/Asset",
  component: AssetDetailView,
  render: (args: { state: Partial<PortfolioScreenState> }) => (
    <StoryFixture component={AssetDetailView} state={args.state} />
  ),
  args: { state: { isPage: true, selected: "a".repeat(32) } },
};
export const Held = {};
export const Privacy = { args: { state: { isPage: true, privacy: true } } };
export const Unavailable = {
  args: { state: { isPage: true, asset: { status: "unavailable", reason: "market_unavailable" } } },
};
