import { AlertsManagerView } from "./AlertsManagerView.js";

export default { title: "Signals/AlertsManager", component: AlertsManagerView };

export const Empty = {
  args: {
    crumb: {
      label: "Breadcrumb",
      items: [{ label: "Investments", onPress() {} }, { label: "Alerts" }],
    },
    title: "Alerts",
    status: { label: "Status", items: [["All", "all"]], value: "all", onChange() {} },
    source: { label: "Source", items: [["All", "all"]], value: "all", onChange() {} },
    checked: "",
    list: {
      label: "Alerts",
      loading: false,
      empty: "No alerts.",
      head: {
        status: "Status",
        alert: "Alert",
        scope: "Scope",
        nowLevel: "Now",
        type: "Type",
        source: "Source",
        last: "Last",
        actions: "Actions",
      },
      rows: [],
      foot: { count: "0", word: "alerts", limit: "agent:", limitValue: "0 of 50" },
    },
    form: null,
    history: {
      title: "Met in 12 months",
      count: "0",
      loading: false,
      empty: "Nothing met yet.",
      exportCsv: null,
      head: [],
      you: "you",
      agent: "agent",
      deleted: "deleted",
      rows: [],
    },
  },
};
