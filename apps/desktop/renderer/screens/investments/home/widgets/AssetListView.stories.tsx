import { AssetListView } from "./AssetListView.js";
import type { AssetListProps } from "./assetListModel.js";

const noop = () => {};
const args: AssetListProps = {
  title: "Assets",
  tabs: {
    label: "Scope",
    items: [
      ["Portfolio 1", "positions"],
      ["Watchlist 0", "watch"],
    ],
    value: "positions",
    onChange: noop,
  },
  tab: "positions",
  positions: {
    split: {
      label: "Split",
      items: [
        ["Total", "total"],
        ["Per account", "account"],
      ],
      value: "total",
      onChange: noop,
    },
    sort: { value: "result", onChange: noop },
    head: {
      inst: "Instrument",
      spark: "30 days",
      price: { text: "Price · week", sort: "week", title: "Sort by week" },
      weight: { text: "Weight", sort: "value", title: "Sort by value" },
      value: { text: "Value · return", sort: "result", title: "Sort by return % · against cost" },
    },
    rows: [
      {
        key: "1",
        onOpen: noop,
        label: {
          tile: {
            monogram: "ACME",
            plan: "M3 7.5l3-3 3 3",
            freshness: null,
            health: "weak",
            faded: false,
          },
          name: "ACME",
          sub: "Synthetic Equity ETF",
          marks: { flag: { state: "positive", label: "chance" }, alert: null, notes: null },
          agent: null,
          classify: null,
          card: {
            tile: { monogram: "ACME" },
            name: "Synthetic Equity ETF",
            detail: "ACME",
            rows: [],
            status: [],
            notes: [
              {
                key: "drawdown_review",
                label: "Strategy",
                text: "-26 % from the high: your strategy asks for a review.",
                tone: "rule",
              },
            ],
          },
          touchTitle: "ACME",
        },
        spark: { values: [1, 2, 3, 2, 4], label: "ACME: 30 days" },
        price: "10.00",
        week: { text: "+1.0%", tone: "positive" },
        weight: { fill: 100, text: "100.0%" },
        value: "1,000.00",
        gain: { text: "+11.1%", tone: "positive", rows: null },
        parts: [
          {
            key: "1:1",
            account: "Broker A IKE",
            weight: { fill: 60, text: "60.0%" },
            value: "600.00",
            gain: { text: "+9.0%", tone: "positive", rows: null },
          },
        ],
      },
    ],
    empty: null,
    cash: { label: "Cash · 1 account", value: "250.00", share: "20.0%" },
    legend: {
      thesis: "Thesis",
      rings: [
        { health: "sup", text: "strengthened" },
        { health: "ful", text: "fulfilled" },
        { health: "weak", text: "weakened" },
        { health: "inv", text: "invalidated" },
      ],
      coin: { path: "M3 7.5l3-3 3 3", text: "recommendation" },
    },
    addTxn: { text: "+ transaction", onPress: noop },
  },
  watch: {
    add: { text: "+ Add", expanded: false, onPress: noop },
    rows: [],
    empty: "Nothing on the watchlist.",
    head: {
      inst: "Instrument",
      recommendation: "Recommendation",
      coverage: "0/0",
      spark: "30 days",
      price: "Price",
      week: "wk",
      alerts: "Alerts",
      actions: "Actions",
    },
    alertsCount: "0",
    alertsWord: "alerts",
  },
};

export default { title: "Desktop/Investments/Home/AssetList", component: AssetListView };
export const Positions = { args };
export const Watchlist = {
  args: {
    ...args,
    tab: "watch",
    watch: {
      ...args.watch,
      rows: [
        {
          key: 7,
          onOpen: noop,
          label: null,
          name: "Synthetic Watch ETF",
          recommendation: { text: "buy", title: "Fits the entry rule" },
          noRecommendation: "none",
          spark: { values: [3, 2, 3, 4], label: "Synthetic Watch ETF: 30 days" },
          price: "25.06",
          noPrice: "no price",
          move: { text: "+0.7%", tone: "positive" },
          alerts: { text: "no alert", muted: true },
          remove: {
            title: "Stop watching",
            label: "Stop watching Synthetic Watch ETF",
            disabled: false,
            onPress: noop,
          },
        },
      ],
    },
  },
};
