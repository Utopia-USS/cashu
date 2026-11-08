import { Money } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import { useState } from "react";
import { useServices } from "../../services/ServicesProvider";
import type { PeriodChoice, SpendingViewProps } from "../money-contracts";
import { budgetPeriod, localToday } from "../screenContext";
import { S } from "./Spending.strings";

export function useSpendingScreen(): SpendingViewProps {
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
  const lang = locale.toLowerCase().startsWith("pl") ? "pl" : "en";
  const spending = useQuery(moneyQueries.budget.spending, {
    today,
    currency,
    period: budgetPeriod(period),
    lang,
  });
  const currencyUse = available.currencies.find((c) => c.currency === currency);
  return {
    currencies,
    currency,
    onCurrencyChange: setRequested,
    period,
    periodBounds: currencyUse ? { first: currencyUse.first, last: currencyUse.last } : null,
    onPeriodChange: setPeriod,
    rows: spending.rows.map((r) => ({
      key: r.category,
      label: r.label,
      amount: new Money(r.amount, currency),
    })),
    total: new Money(spending.total, currency),
    empty: spending.rows.length === 0,
    chart: {
      label: S.title,
      center: {
        title: formatDecimalValue(spending.total, locale, { currency }).text,
        caption: S.total,
        amount: true,
      },
      // Ratios become JS numbers only for drawing. Exact amounts stay in rows and the center.
      segments: spending.rows.map((r, i) => ({
        name: r.label,
        value: spending.total.isZero() ? 0 : Number(r.amount.div(spending.total).toString()),
        color: ((i % 8) + 1) as SpendingViewProps["chart"]["segments"][number]["color"],
      })),
    },
  };
}
