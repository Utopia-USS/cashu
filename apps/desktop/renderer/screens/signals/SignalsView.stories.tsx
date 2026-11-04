import { UiEnvProvider } from "@cashu/ui";
import { AlertsPageView } from "./AlertsPageView.js";
import { DecisionDialogView } from "./DecisionDialogView.js";
import { SignalsListView } from "./SignalsListView.js";
import { SignalsPageView } from "./SignalsView.js";
import {
  signalsStorySnapshot,
  storyAlerts,
  storyFeedback,
  storyList,
  useStoryDecision,
} from "./storyState.js";
import type { SignalsFeedback } from "./useSignalsFeedback.js";

const data = signalsStorySnapshot();
function Page({
  available = true,
  privacy = false,
  feedback = storyFeedback(),
  dialogs = null,
}: {
  available?: boolean;
  privacy?: boolean;
  feedback?: SignalsFeedback;
  dialogs?: React.ReactNode;
}) {
  return (
    <SignalsPageView
      page="alerts"
      available={available}
      privacy={privacy}
      feedback={feedback}
      onBack={() => {}}
      onUndoLast={() => {}}
      dialogs={dialogs}
    >
      <AlertsPageView {...storyAlerts(data, { busy: feedback.busy })} />
    </SignalsPageView>
  );
}
function WithDecision() {
  return <Page dialogs={<DecisionDialogView {...useStoryDecision(data, { estimate: true })} />} />;
}
export default {
  title: "Desktop/Signals/Page",
  component: SignalsPageView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Ready = { render: () => <Page /> };
export const Unavailable = { render: () => <Page available={false} /> };
export const Privacy = {
  render: () => (
    <UiEnvProvider locale="en-US" privacy>
      <Page available={false} privacy />
    </UiEnvProvider>
  ),
};
export const SavedWithUndo = {
  render: () => <Page feedback={storyFeedback({ notice: "saved", undoIds: ["synthetic"] })} />,
};
export const Refusal = {
  render: () => <Page feedback={storyFeedback({ notice: "failed", refusal: "no_alert" })} />,
};
export const Busy = { render: () => <Page feedback={storyFeedback({ busy: true })} /> };
export const SignalsDialogOpen = {
  render: () => <Page dialogs={<SignalsListView {...storyList(data)} />} />,
};
export const DecisionDialogOpen = { render: () => <WithDecision /> };
export const Polish = {
  render: () => (
    <UiEnvProvider locale="pl-PL" privacy={false}>
      <Page feedback={storyFeedback({ notice: "removed" })} />
    </UiEnvProvider>
  ),
};
