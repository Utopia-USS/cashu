import { TxnsDrawerView } from "./InvestmentDrawersView.js";
import type { TxnsDrawerState } from "./useInvestmentDrawers.js";

const noop = () => {};
const state: TxnsDrawerState = {
  tag: "Synthetic ETF",
  error: null,
  rows: [
    {
      key: "1",
      date: "2026-01-02",
      account: "Synthetic broker",
      type: "Buy",
      quantity: "1",
      price: "100.00 PLN",
      cash: "-100.00 PLN",
      tone: "negative",
      source: "manual",
    },
  ],
  onClose: noop,
  onAdd: noop,
};

export default { title: "Investments/Drawers", component: TxnsDrawerView, args: { state } };

export const Transactions = {};
