import { D, Money } from "@cashu/domain";
import type { CashflowViewProps } from "../money-contracts";
import { S } from "./Cashflow.strings";
import { CashflowView } from "./CashflowView";

const base: CashflowViewProps = {
  currencies: ["PLN", "EUR"],
  currency: "PLN",
  onCurrencyChange: () => {},
  period: { kind: "all" },
  periodBounds: { first: "2026-01-01", last: "2026-03-31" },
  onPeriodChange: () => {},
  rows: [
    {
      label: "2026-02",
      income: new Money(D("200.00"), "PLN"),
      expense: new Money(D("230.00"), "PLN"),
      net: new Money(D("-30.00"), "PLN"),
    },
    {
      label: "2026-03",
      income: new Money(D("300.00"), "PLN"),
      expense: new Money(D("150.00"), "PLN"),
      net: new Money(D("150.00"), "PLN"),
    },
  ],
  chart: {
    label: S.title,
    valueKind: "amount",
    values: [-0.2, 1],
    labels: ["2026-02", "2026-03"],
    valueLabels: ["-30,00 zł", "150,00 zł"],
  },
  empty: false,
};

const meta = { title: "Mobile/Cashflow", component: CashflowView, args: base };
export default meta;

export const Monthly = { args: base };
export const OneCurrency = {
  args: { ...base, currencies: ["PLN"] },
};
export const Empty = {
  args: {
    ...base,
    rows: [],
    chart: { ...base.chart, values: [], labels: [], valueLabels: [] },
    empty: true,
  },
};
