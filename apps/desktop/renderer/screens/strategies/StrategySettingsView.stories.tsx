import { UiEnvProvider } from "@cashu/ui";
import { StrategySettingsView } from "./StrategiesView.js";
import { unavailableState } from "./storyState.js";
export default {
  title: "Desktop/Strategies/Settings",
  component: StrategySettingsView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
  args: { state: unavailableState },
};
export const Unavailable = {};
