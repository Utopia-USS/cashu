import { Money } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useState } from "react";
import { useServices } from "../../services/ServicesProvider";
import type { CashflowViewProps, PeriodChoice } from "../money-contracts";
import { budgetPeriod, localToday, plotRatios } from "../screenContext";
import { S } from "./Cashflow.strings";

export function useCashflowScreen(): CashflowViewProps {
  const { locale } = useUiEnv();
  const { moneyQueries } = useServices();
  const today = localToday();
  const available = useQuery(moneyQueries.budget.currencies, { today });
  const currencies = available.currencies.map((c) => c.currency);
  const [requested, setRequested] = useState<string | null>(null);
  const currency =
    requested !== null && currencies.includes(requested)
      ? requested
      : currencies.includes(available.baseCurrency)
        ? available.baseCurrency
        : (currencies[0] ?? available.baseCurrency);
  const [period, setPeriod] = useState<PeriodChoice>({ kind: "all" });
  const cashflow = useQuery(moneyQueries.budget.cashflow, {
    today,
    currency,
    period: budgetPeriod(period),
  });
  const currencyUse = available.currencies.find((c) => c.currency === currency);
  const rows = cashflow.rows.map((r) => ({
    label: r.label,
    income: new Money(r.income, currency),
    expense: new Money(r.expense, currency),
    net: new Money(r.net, currency),
  }));
  return {
    currencies,
    currency,
    onCurrencyChange: setRequested,
    period,
    periodBounds: currencyUse ? { first: currencyUse.first, last: currencyUse.last } : null,
    onPeriodChange: setPeriod,
    rows,
    empty: rows.length === 0,
    chart: {
      label: S.title,
      valueKind: "amount",
      values: plotRatios(cashflow.rows.map((r) => r.net)),
      labels: cashflow.rows.map((r) => r.label),
      // Exact display and accessible text come from Decimal, never the chart coordinate.
      valueLabels: cashflow.rows.map((r) => formatDecimalValue(r.net, locale, { currency }).text),
    },
  };
}
