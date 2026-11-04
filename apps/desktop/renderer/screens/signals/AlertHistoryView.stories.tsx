import { UiEnvProvider } from "@cashu/ui";
import { AlertHistoryView } from "./AlertHistoryView.js";
import { alertHistoryLines } from "./alertModels.js";
import { signalsStorySnapshot } from "./storyState.js";

const rows = alertHistoryLines(signalsStorySnapshot());
export default {
  title: "Desktop/Signals/Alert history",
  component: AlertHistoryView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
export const Ready = {
  render: () => <AlertHistoryView rows={rows} canExport onExport={() => {}} />,
};
export const Empty = {
  render: () => <AlertHistoryView rows={[]} canExport onExport={() => {}} />,
};
export const ExportUnavailable = {
  render: () => <AlertHistoryView rows={rows} canExport={false} onExport={() => {}} />,
};
