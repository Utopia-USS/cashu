import { StrategiesView } from "./StrategiesView.js";
import { readyState, unavailableState } from "./testing/storyState.js";

export default {
  title: "Desktop/Strategies/Strategies",
  component: StrategiesView,
  args: { state: readyState },
};
export const Ready = {};
export const Unavailable = { args: { state: unavailableState } };
