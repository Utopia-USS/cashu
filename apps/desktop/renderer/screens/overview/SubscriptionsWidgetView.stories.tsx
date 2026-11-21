import { SubscriptionsWidgetView } from "./OverviewWidgetsView.js";
import { subscriptions } from "./overviewStoryData.js";

export default {
  title: "Desktop/Overview/Subscriptions",
  component: SubscriptionsWidgetView,
  args: { m: subscriptions },
};
export const Ready = {};
export const NoWarning = { args: { m: { ...subscriptions, warn: null } } };
export const Privacy = {
  args: {
    m: {
      ...subscriptions,
      facts: subscriptions.facts.map((f) => ({ ...f, value: "PLN •••", detail: "•••" })),
    },
  },
};
