import { PendingWidgetView } from "./OverviewWidgetsView.js";
import { pending } from "./overviewStoryData.js";

export default {
  title: "Desktop/Overview/Module not set up",
  component: PendingWidgetView,
  args: { m: pending },
};
export const Steps = {};
export const Ready = {
  args: { m: { ...pending, tag: { text: "ready", tone: "positive" as const }, steps: "" } },
};
