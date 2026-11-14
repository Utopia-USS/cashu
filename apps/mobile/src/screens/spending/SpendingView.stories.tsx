// Pure presentation variants, all invented. Store-backed integration lives in moneyScreens.native.
import { D, Money } from "@cashu/domain";
import type { SpendingRow, SpendingViewProps } from "../money-contracts";
import { SpendingView } from "./SpendingView";

const pln = (amount: string) => new Money(D(amount), "PLN");

const rows: SpendingRow[] = [
  {
    key: "groceries",
    label: "Groceries",
    amount: pln("1412.30"),
    swatch: "palette-1",
    share: D("0.237"),
    vsUsual: { kind: "usual" },
  },
  {
    key: "travel",
    label: "Travel",
    amount: pln("1286.00"),
    swatch: "palette-2",
    share: D("0.216"),
    vsUsual: { kind: "over", text: "+114%" },
  },
  {
    key: "transport",
    label: "Transport",
    amount: pln("642.15"),
    swatch: "palette-3",
    share: D("0.108"),
    vsUsual: { kind: "usual" },
  },
  {
    key: "health",
    label: "Health",
    amount: pln("256.70"),
    swatch: "palette-4",
    share: D("0.043"),
    vsUsual: null,
  },
];

const base: SpendingViewProps = {
  currencies: ["PLN", "EUR"],
  currency: "PLN",
  onCurrencyChange: () => {},
  kind: "month",
  onKindChange: () => {},
  periodLabel: "November 2026",
  onPrevious: () => {},
  onNext: null,
  total: pln("5959.00"),
  vsUsual: { text: "-6.9%", over: false },
  chart: {
    label: "Spending by category",
    center: { title: "PLN 5,959", caption: "Spent so far", amount: true },
    segments: rows.map((r) => ({
      name: r.label,
      value: Number(r.share.toString()),
      color: r.swatch,
    })),
  },
  rows,
  empty: false,
  otherCurrencies: [new Money(D("86.00"), "EUR")],
  closedMonth: null,
  onCategoryPicked: () => {},
  onMonthClosePressed: () => {},
};

const meta = { title: "Mobile/Spending", component: SpendingView, args: base };
export default meta;

export const CurrentMonth = { args: base };
/** One currency: no currency choice beside the period control. */
export const OneCurrency = {
  args: { ...base, currencies: ["PLN"], otherCurrencies: [] } satisfies SpendingViewProps,
};
export const ClosedMonth = {
  args: {
    ...base,
    periodLabel: "October 2026",
    onNext: () => {},
    vsUsual: { text: "+4.2%", over: true },
    chart: { ...base.chart, center: { title: "PLN 13,650", caption: "Spent", amount: true } },
    closedMonth: { month: "2026-10", label: "October 2026 closed" },
    otherCurrencies: [],
  } satisfies SpendingViewProps,
};
export const Quarter = {
  args: {
    ...base,
    kind: "quarter",
    periodLabel: "Q4 2026",
    vsUsual: null,
    rows: rows.map((r) => ({ ...r, vsUsual: null })),
    otherCurrencies: [],
  } satisfies SpendingViewProps,
};
export const ExactLargeValue = {
  args: {
    ...base,
    currency: "EUR",
    rows: [
      {
        key: "other",
        label: "Other",
        amount: new Money(D("9007199254740993.12"), "EUR"),
        swatch: "palette-1",
        share: D("1"),
        vsUsual: null,
      },
    ],
    total: new Money(D("9007199254740993.12"), "EUR"),
    vsUsual: null,
    chart: {
      label: "Spending by category",
      segments: [{ name: "Other", value: 1, color: "palette-1" }],
    },
    otherCurrencies: [],
  } satisfies SpendingViewProps,
};
export const Empty = {
  args: {
    ...base,
    currencies: [],
    rows: [],
    total: pln("0.00"),
    vsUsual: null,
    chart: { label: "Spending by category", segments: [] },
    empty: true,
    otherCurrencies: [],
  } satisfies SpendingViewProps,
};
export const ManyCategories = {
  args: {
    ...base,
    rows: Array.from({ length: 40 }, (_, i) => ({
      key: `synthetic-${i}`,
      label: `Synthetic category ${i + 1}`,
      amount: pln("1.00"),
      swatch: "palette-5" as const,
      share: D("0.025"),
      vsUsual: null,
    })),
    total: pln("40.00"),
    chart: {
      label: "Spending by category",
      segments: Array.from({ length: 40 }, (_, i) => ({
        name: `Synthetic category ${i + 1}`,
        value: 1,
        color: "palette-5" as const,
      })),
    },
  } satisfies SpendingViewProps,
};
