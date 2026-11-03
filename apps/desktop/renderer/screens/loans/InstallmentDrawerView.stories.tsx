import { InstallmentDrawerView } from "./InstallmentDrawerView.js";
import { StoryFixture, storyState } from "./storyState.js";
export default {
  title: "Desktop/Loans/Installment",
  component: InstallmentDrawerView,
  render: (args: { state: Partial<import("./useLoansScreen.js").LoansState> }) => (
    <StoryFixture component={InstallmentDrawerView} state={args.state} />
  ),
  args: { state: { ...storyState, drawer: "payment" as const } },
};
export const Ready = {};
export const Iban = {
  args: { state: { ...storyState, drawer: "payment" as const, mode: "iban" as const } },
};
export const Invalid = {
  args: { state: { ...storyState, drawer: "payment" as const, error: "Synthetic refusal" } },
};
export const Privacy = { args: { state: { ...storyState, privacy: true } } };
