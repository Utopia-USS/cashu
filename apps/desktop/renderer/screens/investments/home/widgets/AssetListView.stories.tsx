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
    sort: {
      label: "Sorting",
      options: [{ value: "result", label: "return %" }],
      value: "result",
      onChange: noop,
    },
    head: {
      inst: "Instrument",
      strategy: "Strategy",
      spark: "30 days",
      price: "Price",
      week: "wk",
      weight: "Weight",
      value: "Value",
      result: "Return",
      resultTitle: "Against cost",
      resultPct: "Return %",
    },
    rows: [
      {
        key: "1",
        onOpen: noop,
        label: {
          tile: { monogram: "ACME", plan: null, freshness: null, health: null, faded: false },
          name: "Synthetic Equity ETF",
          marks: { flag: { state: "positive", label: "chance" }, alert: null, notes: null },
          agent: null,
          classify: null,
          card: {
            tile: { monogram: "ACME" },
            name: "Synthetic Equity ETF",
            detail: "ACME",
            rows: [],
            status: [],
          },
          touchTitle: "ACME",
        },
        hint: null,
        spark: { values: [1, 2, 3, 2, 4], label: "ACME: 30 days" },
        price: "10.00",
        priceStale: null,
        week: { text: "+1.0%", tone: "positive" },
        weight: { fill: 100, text: "100.0%" },
        value: "1,000.00",
        result: { text: "+100", tone: "positive" },
        gain: { text: "+11.1%", tone: "positive", rows: null },
        parts: [],
      },
    ],
    empty: null,
    cash: null,
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
export const Watchlist = { args: { ...args, tab: "watch" } };
