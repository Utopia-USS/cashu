// Synthetic models of the Przegląd tiles for the stories (no store, no real data): the net worth tile with its
// chart, budget, surplus with the year's contributions, investments, accounts, loans, subscriptions and a module
// that is not set up.
import type { InvestmentsSummaryModel, SurplusModel, SurplusYear } from "./investmentsModel.js";
import type { NetWorthWidgetModel } from "./netWorthModel.js";
import type {
  AccountsModel,
  BudgetMonthModel,
  HeroModel,
  LoansModel,
  PendingModel,
  SubscriptionsModel,
} from "./overviewModel.js";

const noop = () => {};
const MASK = "•••";

export const hero: HeroModel = {
  label: "Net worth",
  caption: "Net worth",
  value: "PLN 559,702.01",
  since: "since October",
  delta: [{ text: "+PLN 4,369 (+0.8%)", tone: "positive" }],
  facts: [
    { label: "Assets", value: "PLN 990,902", detail: "4 accounts · 4 modules" },
    { label: "Liabilities", value: "-PLN 431,200", detail: "mortgage, loan" },
    { label: "Home equity", value: "PLN 407,700", detail: "property - mortgage" },
    {
      label: "Investments",
      value: "PLN 61,790",
      detail: [{ text: "-0.1%", tone: "negative" }, { text: " week · 1 chance · 1 risk" }],
    },
    { label: "Liquid", value: "PLN 46,812", detail: "4.1 mo. of spending" },
  ],
  other: "other currencies: €2,140.00",
  meta: "not converted",
};

export const privateHero: HeroModel = {
  ...hero,
  value: `PLN ${MASK}`,
  delta: null,
  facts: hero.facts.map((f) => ({ ...f, value: `PLN ${MASK}` })),
  other: `other currencies: €${MASK}`,
};

const worth = Array.from({ length: 13 }, (_, i) => 480_000 + i * 6_000 + (i > 4 ? 30_000 : 0));
const months = [
  "Nov",
  "Dec",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
];

export const netWorth: NetWorthWidgetModel = {
  title: "Net worth over time",
  mode: {
    label: "Chart type",
    items: [
      ["Line", "line"],
      ["Layers", "stacked"],
    ],
    value: "line",
    onChange: noop,
  },
  scope: {
    label: "Asset scope",
    options: [
      { value: "total", label: "Total (with property)" },
      { value: "liquid", label: "Liquid (accounts only)" },
    ],
    value: "total",
    onChange: noop,
  },
  range: {
    label: "Time range",
    items: [
      ["1M", 31],
      ["3M", 92],
      ["6M", 183],
      ["1Y", 366],
      ["Max", null],
    ],
    value: null,
    onChange: noop,
  },
  step: {
    label: "Chart step",
    items: [
      ["monthly", "monthly"],
      ["weekly", "weekly"],
      ["daily", "daily"],
    ],
    value: "monthly",
    onChange: noop,
  },
  foot: [
    [{ text: "12 mo. " }, { text: "+PLN 79,702 (+16.6%)", bold: true, tone: "positive" }],
    [{ text: "without property " }, { text: "+9.4%", bold: true, tone: "positive" }],
  ],
  empty: null,
  point: (i) =>
    worth[i] == null
      ? null
      : {
          value: `PLN ${(worth[i] ?? 0).toLocaleString("en-US")}.00`,
          date: `${months[i]} 1`,
          detail: "assets PLN 990,902 · liabilities -PLN 431,200",
        },
  chart: {
    kind: "line",
    label: "Net worth over time, PLN",
    values: worth,
    endLabel: "PLN 559,702",
    xLabels: [0, 4, 8, 12].map((i) => ({ i, text: months[i] ?? "" })),
    yFormat: (v) => `${Math.round(v / 1000)}k`,
    tooltip: (i) => ({
      title: `${months[i]} 1`,
      rows: [{ name: "net worth", value: `PLN ${(worth[i] ?? 0).toLocaleString("en-US")}` }],
    }),
  },
};

export const budget: BudgetMonthModel = {
  title: "Budget · October",
  tag: { text: "closed", tone: "positive" },
  link: { label: "Expenses", onPress: noop },
  rows: [
    { key: "in", label: "Income", fill: 100, tone: "accent", value: "PLN 16,200" },
    { key: "out", label: "Expenses", fill: 70.5, value: "PLN 11,420" },
    {
      key: "net",
      label: "Surplus",
      fill: 29.5,
      tone: "positive",
      value: "PLN 4,780",
      valueTone: "positive",
    },
  ],
  empty: "No transactions from last month.",
  foot: [
    [{ text: "savings rate " }, { text: "30%", bold: true }],
    [{ text: "6-mo. avg " }, { text: "24%", bold: true }],
  ],
  others: "+ EUR",
};

const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
const year: SurplusYear = {
  label: "2026 contributions against the plan",
  covered: 9,
  due: 10,
  pct: 90,
  text: "plan covered 9 of 10 mo",
  months: MONTHS.map((initial, k) => {
    const state = k < 9 ? "on" : k === 9 ? "missed" : k === 10 ? "planned" : "ahead";
    return { key: `2026-${k + 1}`, initial, state, title: `month ${k + 1}: ${state}` };
  }),
};

export const surplus: SurplusModel = {
  kind: "card",
  title: "Surplus → contribution",
  highlight: false,
  tag: "11/10",
  link: { label: "month close", onPress: noop },
  flow: [
    { id: "surplus", label: "Oct surplus", value: "PLN 4,780", detail: "PLN 2,500 to invest" },
    { id: "plan", label: "Contribution plan", value: "PLN 2,500", detail: "by day 10" },
    { id: "stays", label: "Left over", value: "PLN 0", detail: "in the account" },
  ],
  checks: [{ text: "✓", tone: "positive" }, { text: " cushion 6 mo" }],
  actions: { kind: "tag", text: "Planned PLN 2,500 · 11/10" },
  change: { label: "change", onPress: noop },
  foot: [
    [
      { text: "contributions 2026: " },
      { text: "PLN 22,500", bold: true },
      { text: " of PLN 25,000" },
    ],
  ],
  footRight: "to be booked by an import",
  year,
};

export const investments: InvestmentsSummaryModel = {
  title: "Investments",
  count: "12 mo",
  link: { label: "Investments", onPress: noop },
  facts: [
    { label: "YTD", value: "+4.0%", tone: "positive", detail: "MSCI ACWI +4.7%" },
    { label: "Opportunities", value: "1", detail: "SYN" },
    { label: "Risks", value: "1", detail: null },
  ],
  chart: { label: "Portfolio value, 12 months", values: [48, 50, 49, 53, 55, 54, 58, 60, 61, 62] },
  review: [{ text: "weekly review: " }, { text: "today", bold: true }],
  rules: [{ text: "rules ok · " }, { text: "9.11", bold: true }],
};

export const accounts: AccountsModel = {
  title: "Accounts",
  count: 5,
  toggle: { label: "show empty (1)", onPress: noop },
  rows: [
    ["Synthetic personal", "mBank · 4821", "PLN 14,220.55"],
    ["Synthetic savings", "mBank · 0193", "PLN 21,400.00"],
    ["Synthetic joint", "Erste · 7710", "PLN 8,912.30"],
    ["Synthetic EUR", "Pekao · 3302", "€2,140.00"],
  ].map(([name = "", sub = "", value = ""]) => ({
    key: name,
    name,
    sub,
    value,
    negative: false,
    muted: false,
    remove: { label: "Remove", title: `Remove account ${name} from view`, onPress: noop },
  })),
  empty: null,
  wallet: [{ text: "Cash in the wallet " }, { text: "PLN 380.00", bold: true }],
  cash: { label: "+ cash expense", onPress: noop },
  confirm: null,
  undone: null,
};

export const loans: LoansModel = {
  title: "Loans",
  count: 2,
  link: { label: "Loans", onPress: noop },
  rows: [
    {
      key: "m",
      name: "Synthetic mortgage",
      meta: "installment PLN 3,410 · 6.1% · until 2049",
      value: "-PLN 412,300.00",
      sub: "-PLN 1,180/mo",
    },
    {
      key: "c",
      name: "Synthetic car loan",
      meta: "installment PLN 1,120 · 8.9% · until 2028",
      value: "-PLN 18,900.00",
      sub: null,
    },
  ],
  empty: null,
  foot: [
    { text: "installments " },
    { text: "PLN 4,530", bold: true },
    { text: "/mo" },
    { text: " · 28% of income" },
  ],
};

export const subscriptions: SubscriptionsModel = {
  title: "Subscriptions",
  count: 9,
  link: { label: "Subscriptions", onPress: noop },
  facts: [
    { label: "Monthly", value: "PLN 486", detail: "4.3% of spending" },
    { label: "This week", value: "2", detail: "Synthetic music, Synthetic cloud" },
  ],
  warn: "1 subscription without a charge",
};

export const pending: PendingModel = {
  id: "loans",
  title: "Loans",
  tag: { text: "1 of 3 steps", tone: "warning" },
  hide: { label: "hide", onPress: noop },
  next: "Next step: add the loan terms",
  steps: "1 of 3 steps done",
  cont: { label: "Continue", onPress: noop },
};
