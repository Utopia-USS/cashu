import { type Decimal, Money } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import { useRouter } from "expo-router";
import { useState } from "react";
import { useServices } from "../../services/ServicesProvider";
import type { MoneyViewProps } from "../money-contracts";
import { localToday, plotRatios } from "../screenContext";
import { S } from "./Money.strings";

export function useMoneyScreen(): MoneyViewProps {
  const { locale } = useUiEnv();
  const { moneyQueries } = useServices();
  const router = useRouter();
  const today = localToday();
  const summary = useQuery(moneyQueries.overview.summary, { today });
  const hero = useQuery(moneyQueries.overview.hero, { today });
  const currencies = Object.keys(summary.networth);
  const [requested, setRequested] = useState<string | null>(null);
  const currency =
    requested !== null && currencies.includes(requested)
      ? requested
      : currencies.includes(hero.facts.currency)
        ? hero.facts.currency
        : (currencies[0] ?? hero.facts.currency);
  const lang = locale.toLowerCase().startsWith("pl") ? "pl" : "en";
  const history = useQuery(moneyQueries.overview.netWorthSeries, {
    today,
    currency,
    lang,
  });
  const total = summary.networth[currency];
  const points = history.points;
  const first = points[0];
  const last = points.at(-1);
  const display = (value: Decimal) => formatDecimalValue(value, locale, { currency }).text;
  const xIndices = [0, Math.floor((points.length - 1) / 2), points.length - 1].filter(
    (i, pos, all) => i >= 0 && all.indexOf(i) === pos,
  );

  return {
    currencies,
    currency,
    onCurrencyChange: setRequested,
    total: total === undefined ? null : new Money(total, currency),
    empty: total === undefined && points.length === 0,
    history: {
      label: S.history,
      valueKind: "amount",
      yFormat: false,
      series: [
        {
          name: S.value,
          values: plotRatios(points.map((p) => p.value)),
          accessibleSummary:
            first && last
              ? `${S.from} ${first.date} ${display(first.value)} ${S.to} ${last.date} ${display(last.value)}`
              : S.noData,
        },
      ],
      xLabels: xIndices.map((i) => ({ i, text: points[i]?.date.slice(0, 7) ?? "" })),
      tooltip: (i) => {
        const point = points[i];
        return {
          title: point?.date ?? "",
          rows: point ? [{ name: S.value, value: display(point.value), amount: true }] : [],
        };
      },
    },
    onCashflow: () => router.push("/cashflow"),
    onSpending: () => router.push("/spending"),
  };
}
