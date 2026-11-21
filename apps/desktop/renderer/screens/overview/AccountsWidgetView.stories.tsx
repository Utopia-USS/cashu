import { AccountsWidgetView } from "./OverviewWidgetsView.js";
import { accounts } from "./overviewStoryData.js";

export default {
  title: "Desktop/Overview/Accounts",
  component: AccountsWidgetView,
  args: { m: accounts },
};
export const Ready = {};
export const OneColumnOfRows = { args: { m: { ...accounts, rows: accounts.rows.slice(0, 1) } } };
export const NoWallet = { args: { m: { ...accounts, wallet: null, toggle: null } } };
export const Empty = {
  args: { m: { ...accounts, rows: [], empty: "No bank accounts.", count: null } },
};
export const ConfirmRemoval = {
  args: {
    m: {
      ...accounts,
      confirm: {
        title: "Remove the account from view?",
        text: "Synthetic joint leaves the overview, the account lists and net worth, and imports into it stop. Its transactions leave the budget (spending, income, cash flow, subscriptions); transfers between it and your accounts still count as own transfers. Restoring the account brings its history back.",
        error: null,
        confirm: { label: "Remove from view", onPress: () => {} },
        cancel: { label: "Cancel", onPress: () => {} },
      },
    },
  },
};
export const Removed = {
  args: {
    m: {
      ...accounts,
      undone: {
        text: "Removed account Synthetic joint from view.",
        error: null,
        undo: { label: "Undo", onPress: () => {} },
      },
    },
  },
};
export const Privacy = {
  args: {
    m: {
      ...accounts,
      rows: accounts.rows.map((r) => ({
        ...r,
        name: "•••",
        sub: "•••",
        value: "PLN •••",
        remove: null,
      })),
      wallet: [{ text: "Cash in the wallet " }, { text: "PLN •••", bold: true }],
    },
  },
};
