import { WatchlistWidgetView } from "./WatchlistWidgetView.js";

export default { title: "Signals/WatchlistWidget", component: WatchlistWidgetView };

export const Ready = {
  args: {
    count: 1,
    adding: false,
    onAdd() {},
    search: null,
    alerts: 0,
    alertsWord: "alerts",
    rows: [
      {
        key: 1,
        tile: { monogram: "SYN" },
        name: "Synthetic Co",
        agent: false,
        summary: "no alert",
        spark: { values: [1, 2, 3], label: "30 days" },
        price: "10,00 zł",
        noPrice: "no price",
        stale: null,
        move: { text: "+2,0 % week", tone: "positive" },
        remove: {
          title: "Stop watching",
          label: "Stop watching Synthetic Co",
          disabled: false,
          onPress() {},
        },
        onOpen() {},
      },
    ],
  },
};
export const Empty = { args: { ...Ready.args, count: null, rows: [] } };
