import { HomeLoadingView, HomeView } from "./HomeView.js";

const handlers = { onAccount() {}, onStale() {}, onImport() {}, onAddTxn() {} };
const head = {
  accounts: null,
  prices: { text: "prices Fri 30.10" },
  stale: null,
  rules: null,
  addTxn: false,
};

export default { title: "Investments/Home", component: HomeView };

export const Home = {
  args: {
    ...handlers,
    head,
    content: {
      kind: "home",
      hero: {
        value: "1 000,00 PLN",
        week: { text: "+10,00 PLN (+1,0 %)", tone: "positive" },
        facts: [{ label: "YTD", value: "+1,0 %", detail: "no history" }],
      },
      reviewSlot: null,
      main: [],
      rail: [],
      research: null,
    },
  },
};

export const Start = {
  args: {
    ...handlers,
    head: { ...head, prices: null, addTxn: true },
    content: {
      kind: "start",
      start: {
        steps: [{ key: "account", status: "on", title: "Account", hint: "Broker", actions: [] }],
        command: "cashu invest accounts add",
      },
      onCopy() {},
      onSettings() {},
    },
  },
};

export const Loading = { render: () => <HomeLoadingView /> };
