import { UiEnvProvider } from "@cashu/ui";
import { SignalsHomeRailView } from "./SignalsHomeRailView.js";
import { emptyStorySnapshot, signalsStorySnapshot, storyRail } from "./storyState.js";

export default {
  title: "Desktop/Signals/Home rail",
  component: SignalsHomeRailView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const PartialRun = {
  render: () => <SignalsHomeRailView {...storyRail(signalsStorySnapshot())} />,
};
export const Empty = { render: () => <SignalsHomeRailView {...storyRail(emptyStorySnapshot())} /> };
export const Unavailable = { render: () => <SignalsHomeRailView {...storyRail(null)} /> };
export const Privacy = {
  render: () => (
    <UiEnvProvider locale="en-US" privacy>
      <SignalsHomeRailView {...storyRail(null, true)} />
    </UiEnvProvider>
  ),
};
export const Polish = {
  render: () => (
    <UiEnvProvider locale="pl-PL" privacy={false}>
      <SignalsHomeRailView {...storyRail(signalsStorySnapshot())} />
    </UiEnvProvider>
  ),
};
