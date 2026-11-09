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
export const Privacy = {
  args: {
    m: {
      ...accounts,
      rows: accounts.rows.map((r) => ({ ...r, name: "•••", sub: "•••", value: "PLN •••" })),
      wallet: [{ text: "Cash in the wallet " }, { text: "PLN •••", bold: true }],
    },
  },
};
