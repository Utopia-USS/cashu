// Pure presentation variants, all invented. Store-backed integration lives in moneyScreens.native.
import { D, Money } from "@cashu/domain";
import type { SpendingViewProps } from "../money-contracts";
import { S } from "./Spending.strings";
import { SpendingView } from "./SpendingView";

const base: SpendingViewProps = {
  currencies: ["PLN", "EUR"],
  currency: "PLN",
  onCurrencyChange: () => {},
  period: { kind: "month", year: 2026, month: 9 },
  periodBounds: { first: "2026-01-01", last: "2026-09-30" },
  onPeriodChange: () => {},
  rows: [
    { key: "groceries", label: "Groceries", amount: new Money(D("120.34"), "PLN") },
    { key: "transport", label: "Transport", amount: new Money(D("34.56"), "PLN") },
  ],
  total: new Money(D("154.90"), "PLN"),
  chart: {
    label: S.title,
    segments: [
      { name: "Groceries", value: 0.78, color: 1 },
      { name: "Transport", value: 0.22, color: 2 },
    ],
  },
  empty: false,
};

const meta = { title: "Mobile/Spending", component: SpendingView, args: base };
export default meta;

export const MultipleCategories = { args: base };
export const ExactLargeValue = {
  args: {
    ...base,
    currency: "EUR",
    rows: [{ key: "other", label: "Other", amount: new Money(D("9007199254740993.12"), "EUR") }],
    total: new Money(D("9007199254740993.12"), "EUR"),
    chart: { label: S.title, segments: [{ name: "Other", value: 1, color: 1 }] },
  } satisfies SpendingViewProps,
};
export const Empty = {
  args: {
    ...base,
    currencies: [],
    rows: [],
    periodBounds: null,
    total: new Money(D("0.00"), "PLN"),
    chart: { label: S.title, segments: [] },
    empty: true,
  } satisfies SpendingViewProps,
};
export const ManyCategories = {
  args: {
    ...base,
    rows: Array.from({ length: 40 }, (_, i) => ({
      key: `synthetic-${i}`,
      label: `Synthetic category ${i + 1}`,
      amount: new Money(D("1.00"), "PLN"),
    })),
    total: new Money(D("40.00"), "PLN"),
    chart: {
      label: S.title,
      segments: Array.from({ length: 40 }, (_, i) => ({
        name: `Synthetic category ${i + 1}`,
        value: 1,
        color: ([1, 2, 3, 4, 5, 6, 7, 8] as const)[i % 8] ?? 1,
      })),
    },
  } satisfies SpendingViewProps,
};
