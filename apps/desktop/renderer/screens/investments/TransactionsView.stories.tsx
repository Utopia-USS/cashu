import { StoryFixture } from "./storyState.js";
import { TransactionsView } from "./TransactionsView.js";
export default {
  title: "Desktop/Investments/Transactions",
  component: TransactionsView,
  render: () => <StoryFixture component={TransactionsView} />,
};
export const Empty = {};
