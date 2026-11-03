import { UiEnvProvider } from "@cashu/ui";
import { StrategiesView, StrategySettingsView } from "./StrategiesView.js";
import { readyState, unavailableState } from "./storyState.js";
export default {
  title: "Desktop/Strategies/Strategies",
  component: StrategiesView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
  args: { state: readyState },
};
export const Ready = {};
export const Unavailable = { args: { state: unavailableState } };
export const Privacy = { args: { state: { ...unavailableState, privacy: true } } };
export const Settings = { render: () => <StrategySettingsView state={unavailableState} /> };
