import { UiEnvProvider } from "@cashu/ui";
import { JournalPageView } from "./JournalPageView.js";
import { emptyStorySnapshot, signalsStorySnapshot, storyJournal } from "./storyState.js";

export default {
  title: "Desktop/Signals/Journal page",
  component: JournalPageView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Ready = {
  render: () => <JournalPageView {...storyJournal(signalsStorySnapshot())} />,
};
export const Empty = { render: () => <JournalPageView {...storyJournal(emptyStorySnapshot())} /> };
