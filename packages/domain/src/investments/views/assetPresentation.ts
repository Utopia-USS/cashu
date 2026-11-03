/** Source AssetPage/lotRows display facts, keeping amounts exact until chart geometry. */

import { monthsBack } from "../../dates.js";
import { D, type Decimal, ZERO } from "../../decimal.js";
import type { PositionChartView } from "./positionChart.js";
import type { PositionDetailView } from "./positionDetail.js";
import type { PositionRow } from "./positions.js";

export interface PriceAlertFact {
  readonly id: string;
  readonly status: string;
  readonly kind: string;
  readonly level: number | null;
}

export function assetQuoteFacts(
  chart: PositionChartView,
  fallback: Decimal | null,
  alerts: readonly PriceAlertFact[] = [],
) {
  const last = chart.last?.close ?? fallback;
  const high = chart.high_52w;
  const closes = chart.series.map((point) => point.close);
  const sample = closes.slice(-31);
  let volatility30: number | null = null;
  // The original SPA uses unannualized sample standard deviation of displayed log returns.
  if (sample.length >= 10 && sample.every((close) => close.gt(ZERO))) {
    const returns = sample.slice(1).map((value, index) => {
      const previous = sample[index];
      return previous === undefined ? Number.NaN : Math.log(value.div(previous).toFloat());
    });
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const value = Math.sqrt(
      returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1),
    );
    if (Number.isFinite(value)) volatility30 = value;
  }
  const nearest =
    last === null || last.isZero()
      ? null
      : (alerts
          .filter(
            (alert) =>
              ["active", "triggered", "snoozed"].includes(alert.status) &&
              ["price_above", "price_below"].includes(alert.kind) &&
              alert.level !== null &&
              Number.isFinite(alert.level),
          )
          .map((alert) => ({ alert, distance: (alert.level ?? 0) / last.toFloat() - 1 }))
          .filter((item) => Number.isFinite(item.distance))
          .sort((left, right) => Math.abs(left.distance) - Math.abs(right.distance))[0] ?? null);
  return {
    fromHigh:
      high === null || last === null || high.isZero() || last.isZero()
        ? null
        : last.div(high).toFloat() - 1,
    rangeLow:
      closes.length < 2 ? null : closes.reduce((left, right) => (left.lt(right) ? left : right)),
    volatility30,
    nearest,
  };
}

export function assetLotFacts(lots: PositionRow["lots"]) {
  return {
    rows: [...lots]
      .sort((left, right) => left.open_date.localeCompare(right.open_date))
      .map((lot) => {
        const cost = lot.unit_cost?.mul(lot.quantity) ?? null;
        return {
          ...lot,
          resultPct:
            lot.result === null || cost === null || cost.isZero()
              ? null
              : lot.result.div(cost).toFloat(),
        };
      }),
    multiAccount: new Set(lots.map((lot) => lot.account_id)).size > 1,
  };
}

/** Legacy AssetPage fee header sums currencies. Native display deliberately groups original units. */
export function assetFeeSummary(transactions: PositionDetailView["transactions"]) {
  const amounts = new Map<string, Decimal>();
  for (const row of transactions) {
    if (row.fee !== null)
      amounts.set(row.currency, (amounts.get(row.currency) ?? ZERO).add(row.fee));
  }
  return [...amounts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, amount]) => ({ amount, currency }));
}

/** Monetary flow aggregation is exact; Number is used only by the existing performance DTO. */
export function monthlyContributions(
  points: readonly { readonly date: string; readonly flow: number | null }[],
  today: string,
) {
  // Conversion into Decimal at this established source DTO boundary preserves its published digits.
  const sums = new Map<string, Decimal>();
  const months = Array.from({ length: 12 }, (_, index) =>
    monthsBack(today, 11 - index).slice(0, 7),
  );
  for (const point of points) {
    const month = point.date.slice(0, 7);
    if (point.flow !== null && point.flow > 0)
      sums.set(month, (sums.get(month) ?? ZERO).add(D(String(point.flow))));
  }
  return months.map((month) => ({ month, amount: sums.get(month) ?? ZERO }));
}
