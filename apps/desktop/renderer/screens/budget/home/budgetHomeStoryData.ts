// Synthetic states of the budget screen for its stories (no real data: invented payees, round amounts).
import type {
  AfterMonthState,
  BudgetHomeState,
  ChartGroupState,
  DrillState,
  OtherSurplusState,
  SliceState,
  SubscriptionsState,
  UncategorizedState,
} from "./budgetHomeState.js";

const noop = () => {};
const MONTHS = [
  "Nov",
  "Dec",
  "Jan '26",
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
const INCOME = [
  14_400, 17_300, 14_900, 14_950, 14_800, 14_820, 14_900, 21_200, 14_880, 14_870, 14_910, 16_900,
  3_600,
];
const SPENT = [
  9_700, 11_000, 10_500, 9_400, 10_800, 10_200, 11_100, 10_100, 14_900, 10_500, 9_400, 10_862,
  2_300,
];

const zl = (v: number) =>
  `${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true }).format(v)} PLN`;

const chartGroups: ChartGroupState[] = MONTHS.map((label, k) => ({
  key: 24_310 + k,
  label,
  income: INCOME[k] ?? 0,
  expense: SPENT[k] ?? 0,
  selected: k === 11,
  partial: k === 12,
  tip: {
    title: label,
    rows: [
      { name: "Income", value: zl(INCOME[k] ?? 0) },
      { name: "Spent", value: zl(SPENT[k] ?? 0) },
      { name: "Surplus", value: `+${zl((INCOME[k] ?? 0) - (SPENT[k] ?? 0))}` },
    ],
  },
}));

const palette = (n: number) => `var(--color-palette-${n})`;
const CATS: [string, string, number][] = [
  ["rent", "Housing/Rent", 2_502.47],
  ["groceries", "Groceries", 1_643.56],
  ["shopping", "Shopping", 1_578.62],
  ["travel", "Travel", 1_042.56],
  ["dining", "Dining out", 1_007.16],
  ["other", "Other", 938.29],
  ["transport", "Transport", 888.77],
  ["health", "Health", 439.15],
  ["fun", "Entertainment", 425.43],
  ["subscriptions", "Subscriptions", 396.39],
];
const TOTAL = CATS.reduce((a, c) => a + c[2], 0);

export const slices: SliceState[] = CATS.map(([key, label, v], i) => ({
  key,
  label,
  value: v,
  amount: zl(v),
  share: `${Math.round((v / TOTAL) * 100)}%`,
  shareText: `${Math.round((v / TOTAL) * 100)}% of spending`,
  color: palette(i + 1),
  fill: (v / 2_502.47) * 100,
}));

export const drill: DrillState = {
  key: "groceries",
  label: "Groceries",
  color: palette(2),
  meta: "6 transactions · Oct 2026",
  sort: "date",
  sortItems: [
    ["Newest", "date"],
    ["Largest", "amount"],
  ],
  sortLabel: "Sort by",
  setSort: noop,
  close: noop,
  closeLabel: "Close",
  rows: [
    ["22 Oct", "DEMO SHOP A", "card", "Demo account", -144.75],
    ["20 Oct", "DEMO SHOP B", "card · Warsaw", "Demo account", -424.57],
    ["17 Oct", "DEMO SHOP C", null, "Demo card", -293.67],
    ["9 Oct", "DEMO SHOP A", "card", "Demo account", -210.76],
  ].map(([date, merchant, details, account, v], k) => ({
    key: `t${k}`,
    date: String(date),
    merchant: String(merchant),
    details: details === null ? null : String(details),
    account: String(account),
    amount: zl(Number(v)),
    negative: true,
    category: "groceries",
  })),
  more: { label: "Show all 12", onPress: noop },
  empty: "No transactions in this period.",
  categoryLabel: "Category",
  options: [
    { value: "groceries", label: "Groceries" },
    { value: "dining", label: "Dining out" },
    { value: "cash_withdrawal", label: "Cash withdrawal" },
  ],
  busy: false,
  markCategory: noop,
};

const sub = (k: number, payee: string, amount: string, when: string | null, soon = false) => ({
  key: `s${k}`,
  initial: payee[0] ?? "?",
  payee,
  cadence: when === null ? "last 2 May" : "monthly",
  amount,
  when,
  soon,
});

export const subscriptions: SubscriptionsState = {
  title: "Subscriptions",
  count: "6 active",
  monthly: { value: "439.69 PLN", unit: "/ month" },
  extra: [],
  sub: "5,276 PLN a year · 4% of spending",
  nextLabel: "Next charges",
  next: [
    sub(1, "Demo gym", "159.00 PLN", "tomorrow", true),
    sub(2, "Demo music", "37.99 PLN", "in 5 days", true),
    sub(3, "Demo cloud", "49.99 PLN", "in 9 days"),
    sub(4, "Demo phone", "45.00 PLN", "in 11 days"),
  ],
  rest: [
    sub(5, "Demo video", "60.00 PLN", "in 23 days"),
    sub(6, "Demo assistant", "89.00 PLN", "in 27 days"),
  ],
  endedLabel: "Ended",
  ended: [sub(7, "Demo course", "26.99 PLN", null)],
  open: false,
  toggle: { label: "Show all 6 and 1 ended", onPress: noop },
  empty: null,
};

export const afterMonth: AfterMonthState = {
  title: "After the month",
  amount: "6,038 PLN",
  sub: "free to invest",
  empty: null,
  plan: {
    label: "Contribution plan",
    value: "4,000 PLN / mo",
    note: "covered, 2,038 PLN left over",
    tone: "positive",
  },
  cushion: {
    label: "Emergency cushion",
    text: "off",
    title: undefined,
    button: "Set",
    disabled: false,
    open: false,
    toggle: noop,
  },
  form: null,
};

export const uncategorized: UncategorizedState = {
  title: "Needs a category",
  summary: "12 merchants · 1,284.30 PLN counted as Other",
  rows: [
    { key: "a", name: "DEMO PAYMENTS SA", count: "4 transactions", total: "612.40 PLN" },
    { key: "b", name: "DEMO WEBSHOP 1189", count: "3 transactions", total: "289.97 PLN" },
    { key: "c", name: "DEMO CAFE", count: "7 transactions", total: "141.60 PLN" },
  ],
  review: { label: "Review", onPress: noop },
};

/** October 2026 closed, PLN with a little EUR. */
export const ready: BudgetHomeState = {
  period: {
    mode: "month",
    setMode: noop,
    label: "Oct 2026",
    stepHidden: false,
    prevDisabled: false,
    nextDisabled: false,
    step: noop,
    inProgress: false,
  },
  currency: { value: "PLN", codes: ["PLN", "EUR"], set: noop },
  hero: {
    label: "Surplus",
    value: "PLN 6,037.60",
    negative: false,
    sub: { delta: "+1,099 PLN", positive: true, text: "vs your 12-month average" },
    meters: [
      { key: "in", label: "Income", fill: 100, tone: "positive", value: "16,900.00 PLN" },
      { key: "out", label: "Spent", fill: 64, tone: "negative", value: "10,862.40 PLN" },
      { key: "kept", label: "Kept", fill: 36, tone: "muted", value: "36%" },
    ],
    chart: {
      label: "Income and spending",
      groups: chartGroups,
      ticks: [0, 10_000, 20_000, 30_000].map((value) => ({ value, label: `${value / 1000}K` })),
      top: 30_000,
      select: noop,
    },
    legend: { income: "Income", spent: "Spent" },
  },
  spending: {
    title: "Spending",
    total: "10,862 PLN",
    slices,
    selected: null,
    select: noop,
    label: "Spending",
    empty: null,
  },
  drill: null,
  subscriptions,
  afterMonth,
  uncategorized,
};

/** The other currencies' surplus links of the hero. */
export const otherSurplus: OtherSurplusState[] = [
  {
    currency: "EUR",
    lead: "Also in EUR:",
    value: "-71.15 EUR",
    title: "Show the budget in EUR",
    onPress: noop,
  },
  {
    currency: "USD",
    lead: "Also in USD:",
    value: "+12.40 USD",
    title: "Show the budget in USD",
    onPress: noop,
  },
];
