import { UiEnvProvider } from "@cashu/ui";
import { ReviewEntryView } from "./ReviewEntryView.js";
import { storySnapshot } from "./storyState.js";

const state = {
  data: storySnapshot(),
  privacy: false,
  lastOn: null,
  canUndo: false,
  undo: async () => {},
  busy: false,
  failure: false,
};
export default {
  title: "Desktop/Review/Entry",
  component: ReviewEntryView,
  args: { state, onOpened() {} },
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Due = {};
export const Undo = { args: { state: { ...state, canUndo: true } } };
export const Unavailable = {
  args: { state: { ...state, data: { status: "unavailable", reason: "source_unbound" } } },
};
