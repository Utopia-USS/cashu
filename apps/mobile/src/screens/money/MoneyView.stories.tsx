import { D, Money } from "@cashu/domain";
import type { MoneyViewProps } from "../money-contracts";
import { S } from "./Money.strings";
import { MoneyView } from "./MoneyView";

const base: MoneyViewProps = {
  currencies: ["PLN", "EUR"],
  currency: "PLN",
  onCurrencyChange: () => {},
  total: new Money(D("12345.67"), "PLN"),
  history: {
    label: S.history,
    valueKind: "amount",
    yFormat: false,
    series: [{ name: S.value, values: [0.5, 0.75, 1], accessibleSummary: S.history }],
    xLabels: [
      { i: 0, text: "2026-01" },
      { i: 2, text: "2026-03" },
    ],
    tooltip: (i) => ({
      title: `2026-0${i + 1}`,
      rows: [{ name: S.value, value: "12,345.67 PLN", amount: true }],
    }),
  },
  empty: false,
  onCashflow: () => {},
  onSpending: () => {},
};

const meta = { title: "Mobile/Money", component: MoneyView, args: base };
export default meta;

export const MultipleCurrencies = { args: base };
export const Negative = {
  args: {
    ...base,
    currency: "EUR",
    total: new Money(D("-42.01"), "EUR"),
    history: {
      ...base.history,
      series: [{ name: S.value, values: [-1, -0.5, -0.25], accessibleSummary: S.history }],
      tooltip: (i: number) => ({
        title: `2026-0${i + 1}`,
        rows: [{ name: S.value, value: "-42,01 EUR", amount: true }],
      }),
    },
  },
};
export const Empty = {
  args: {
    ...base,
    currencies: [],
    total: null,
    history: { ...base.history, series: [{ values: [] }], xLabels: [] },
    empty: true,
  },
};
