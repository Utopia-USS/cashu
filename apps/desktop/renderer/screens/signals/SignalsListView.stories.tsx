import { UiEnvProvider } from "@cashu/ui";
import { SignalsListView } from "./SignalsListView.js";
import { emptyStorySnapshot, signalsStorySnapshot, storyList } from "./storyState.js";

export default {
  title: "Desktop/Signals/Signals dialog",
  component: SignalsListView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Ready = { render: () => <SignalsListView {...storyList(signalsStorySnapshot())} /> };
export const Empty = { render: () => <SignalsListView {...storyList(emptyStorySnapshot())} /> };
export const Unavailable = { render: () => <SignalsListView {...storyList(null)} /> };
export const Busy = {
  render: () => <SignalsListView {...storyList(signalsStorySnapshot(), { busy: true })} />,
};
export const Refusal = {
  render: () => (
    <SignalsListView
      {...storyList(signalsStorySnapshot(), { notice: "failed", refusal: "signal_closed" })}
    />
  ),
};
