import { UiEnvProvider } from "@cashu/ui";
import { AlertsPageView } from "./AlertsPageView.js";
import { emptyStorySnapshot, signalsStorySnapshot, storyAlerts } from "./storyState.js";

export default {
  title: "Desktop/Signals/Alerts page",
  component: AlertsPageView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Ready = { render: () => <AlertsPageView {...storyAlerts(signalsStorySnapshot())} /> };
export const Empty = { render: () => <AlertsPageView {...storyAlerts(emptyStorySnapshot())} /> };
export const AfterDelete = {
  render: () => <AlertsPageView {...storyAlerts(signalsStorySnapshot(), { canRestore: true })} />,
};
