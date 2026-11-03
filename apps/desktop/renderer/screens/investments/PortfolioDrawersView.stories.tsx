import { PortfolioDrawersView } from "./PortfolioDrawersView.js";
import { StoryFixture } from "./storyState.js";
import type { PortfolioScreenState } from "./usePortfolioScreen.js";
export default {
  title: "Desktop/Investments/Drawers",
  component: PortfolioDrawersView,
  render: (args: { state: Partial<PortfolioScreenState> }) => (
    <StoryFixture component={PortfolioDrawersView} state={args.state} />
  ),
  args: { state: { drawer: "transaction" } },
};
export const Transaction = {};
export const Account = { args: { state: { drawer: "account" } } };
export const Thesis = { args: { state: { drawer: "thesis" } } };
export const Note = { args: { state: { drawer: "note" } } };
export const Classification = { args: { state: { drawer: "classification" } } };
export const ImportUnavailable = { args: { state: { drawer: "import" } } };
export const Refusal = { args: { state: { drawer: "transaction", error: "Synthetic refusal" } } };
export const Pending = { args: { state: { drawer: "transaction", busy: true } } };
