import { HomeLoadingView, HomeView } from "./HomeView.js";

const handlers = { onAccount() {}, onStale() {}, onAddTxn() {} };
const head = {
  accounts: null,
  prices: null,
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
        valueParts: { pre: "", main: "1 000", fraction: ",00", post: " PLN" },
        week: { text: "+10,00 PLN (+1,0 %)", tone: "positive" },
        facts: [{ key: "ytd", label: "YTD", value: "+1,0 %", detail: "no history" }],
      },
      reviewSlot: null,
      main: [],
      rail: [],
      research: null,
    },
  },
};

export const HomeWithTags = {
  args: {
    ...Home.args,
    head: {
      ...head,
      accounts: {
        items: [
          ["All", null],
          ["Broker A", 1],
        ],
        value: null,
      },
      stale: { text: "2 out of date", title: "ACME: last quote 12.10" },
      rules: { text: "rules partial", title: "today 06:00", warn: true },
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
    },
  },
};

export const Loading = { render: () => <HomeLoadingView /> };
