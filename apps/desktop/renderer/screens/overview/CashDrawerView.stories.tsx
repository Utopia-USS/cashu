import { D } from "@cashu/domain";
import { UiEnvProvider } from "@cashu/ui";
import { CashDrawerView, type CashDrawerViewProps } from "./CashDrawerView.js";

const state: CashDrawerViewProps["state"] = {
  wallet: {
    exists: true,
    currency: "PLN",
    balance: D("42.00"),
    withdrawals: D("50.00"),
    expenses: D("8.00"),
    transactions: [
      {
        gid: "synthetic-row",
        date: "2026-10-01",
        amount: D("-8.00"),
        title: "Synthetic purchase",
        category: "groceries",
        kind: "expense",
      },
    ],
  },
  open: true,
  amount: "",
  title: "",
  category: "groceries",
  categories: [{ key: "groceries", label: "Groceries" }],
  error: null,
  busy: false,
  setOpen: () => {},
  setAmount: () => {},
  setTitle: () => {},
  setCategory: () => {},
  submit: async () => {},
  deleteRow: async () => {},
};

export default {
  title: "Desktop/Overview/Cash drawer",
  component: CashDrawerView,
  args: { state },
};
export const Ready = {};
export const Empty = {
  args: { state: { ...state, wallet: { ...state.wallet, transactions: [] } } },
};
export const Privacy = {
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider privacy>
        <Story />
      </UiEnvProvider>
    ),
  ],
};
