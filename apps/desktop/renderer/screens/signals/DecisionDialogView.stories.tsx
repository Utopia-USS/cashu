import { UiEnvProvider } from "@cashu/ui";
import { DecisionDialogView } from "./DecisionDialogView.js";
import { signalsStorySnapshot, useStoryDecision } from "./storyState.js";

function Story({ busy = false, estimate = false }: { busy?: boolean; estimate?: boolean }) {
  return <DecisionDialogView {...useStoryDecision(signalsStorySnapshot(), { busy, estimate })} />;
}
export default {
  title: "Desktop/Signals/Decision dialog",
  component: DecisionDialogView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Open = { render: () => <Story /> };
export const BuyEstimate = { render: () => <Story estimate /> };
export const Busy = { render: () => <Story busy /> };
export const Polish = {
  render: () => (
    <UiEnvProvider locale="pl-PL" privacy={false}>
      <Story estimate />
    </UiEnvProvider>
  ),
};
