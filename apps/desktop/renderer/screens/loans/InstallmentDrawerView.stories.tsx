import { InstallmentDrawerView } from "./InstallmentDrawerView.js";
import { StoryFixture, storyState } from "./storyState.js";

const open = { ...storyState, drawer: { kind: "payment" as const } };
export default {
  title: "Desktop/Loans/Installment",
  component: InstallmentDrawerView,
  render: (args: { state: Partial<import("./useLoansScreen.js").LoansState> }) => (
    <StoryFixture component={InstallmentDrawerView} state={args.state} />
  ),
  args: { state: open },
};
export const Ready = {};
export const Iban = {
  args: {
    state: {
      ...open,
      payment: { ...open.payment, mode: "iban" as const, storedTail: "1234", stored: true },
    },
  },
};
export const Invalid = { args: { state: { ...open, err: "Synthetic refusal" } } };
export const Privacy = { args: { state: { ...storyState, privacy: true } } };
