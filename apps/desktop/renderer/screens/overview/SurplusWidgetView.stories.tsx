import { SurplusWidgetView } from "./InvestmentsWidgetView.js";
import { surplus } from "./overviewStoryData.js";

export default {
  title: "Desktop/Overview/Surplus",
  component: SurplusWidgetView,
  args: { m: surplus },
};
/** Planned this month: the tag with the change link, the year's ring and strip. */
export const Planned = {};
/** Nothing planned yet: the highlighted tile with the plan buttons. */
export const ToPlan = {
  args: {
    m: {
      ...surplus,
      highlight: true,
      change: null,
      actions: {
        kind: "buttons" as const,
        primary: { label: "Plan PLN 2,500", disabled: false, onPress: () => {} },
        other: { label: "Other amount", onPress: () => {} },
      },
    },
  },
};
/** Without a monthly plan amount: no ring and no strip. */
export const NoPlan = { args: { m: { ...surplus, year: null } } };
export const NoMonthClose = {
  args: { m: { kind: "none" as const, title: "Surplus → contribution", text: "No month close." } },
};
