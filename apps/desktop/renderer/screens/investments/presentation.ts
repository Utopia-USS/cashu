import type { Decimal } from "@cashu/domain";
import { S, THRESHOLD_WORD } from "@cashu/i18n/investments/v2/AssetPage.strings";
import type { AssetSnapshot } from "@cashu/store/investments/screen";
import type { LineChartProps } from "@cashu/ui";
import { localIsoDate, serverDate } from "@cashu/ui-logic/core/time";
import { assetClass, bucketLabel, region } from "@cashu/ui-logic/investments/labels";
import { FRESH_LABEL, freshOf, hintChip, planLabel } from "@cashu/ui-logic/investments/v2/logic";
import { I } from "./Portfolio.strings.js";

export function investmentCalendarDate(value: string | null): string | null {
  const date = serverDate(value);
  return date === null ? null : localIsoDate(date);
}
export function investmentAllocationLabel(
  mode: "buckets" | "classes" | "regions",
  key: string,
): string {
  return mode === "buckets"
    ? (bucketLabel(key) ?? "")
    : mode === "classes"
      ? assetClass(key)
      : region(key);
}

export function investmentMarks(
  instrument: {
    readonly plan?: string | null;
    readonly plan_freshness?: { readonly state: "fresh" | "maybe_outdated" | "outdated" } | null;
  },
  hints: readonly { readonly code: string; readonly params: Readonly<Record<string, unknown>> }[],
  held: boolean,
): string[] {
  const fresh = freshOf(instrument.plan_freshness);
  return [
    ...new Set(
      [
        planLabel(instrument.plan, held),
        fresh === null ? "" : FRESH_LABEL[fresh],
        ...hints.map((hint) => hintChip(hint, held)),
      ].filter(Boolean),
    ),
  ];
}

/** Actual source marker-date geometry and labels; amounts are already valued by the domain. */
export function assetChartPresentation(
  data: Extract<AssetSnapshot, { status: "ready" }>,
  format: (value: Decimal) => string,
  privacy: boolean,
  small = false,
): LineChartProps {
  const chart = data.chart;
  const amount = (value: Decimal) => (privacy ? "•••" : format(value));
  const markers = chart.markers.flatMap((marker) => {
    const first = chart.series[0];
    if (chart.series.length < 2 || first === undefined || marker.date < first.date) return [];
    const found = chart.series.findIndex((point) => point.date >= marker.date);
    return [
      {
        i: found < 0 ? chart.series.length - 1 : found,
        kind: marker.type === "sell" ? ("sell" as const) : ("buy" as const),
      },
    ];
  });
  const levels: NonNullable<LineChartProps["levels"]> = [
    ...data.priceAlerts.map((alert) => ({
      y: alert.level,
      kind: alert.source === "agent" ? ("agent" as const) : ("alert" as const),
      label: `${alert.source === "agent" ? S.agentAlert : S.alert} · ${alert.kind === "price_below" ? S.below : S.above}`,
    })),
    ...chart.thresholds.map((threshold) => ({
      y: threshold.y.toFloat(),
      kind: "rule" as const,
      muted: true,
      label: S.threshold(
        THRESHOLD_WORD[threshold.kind as keyof typeof THRESHOLD_WORD] ?? S.rule,
        threshold.kind === "gain_from_cost" ? "+" : "-",
        Math.round(threshold.threshold * 100),
        threshold.basis === "cost",
        amount(threshold.y),
      ),
    })),
    ...(chart.high_52w === null
      ? []
      : [
          {
            y: chart.high_52w.toFloat(),
            kind: "rule" as const,
            muted: true,
            label: `${S.high52} · ${amount(chart.high_52w)}`,
          },
        ]),
    ...(chart.cost?.average && data.detail.position?.valuation_mode === "market"
      ? [
          {
            y: chart.cost.average.toFloat(),
            kind: "cost" as const,
            muted: true,
            label: `${S.avgCost} · ${amount(chart.cost.average)}`,
          },
        ]
      : []),
  ];
  return {
    label: I.price,
    height: 240,
    padL: small ? 36 : 46,
    padR: small ? 150 : 200,
    series: [
      {
        values: chart.series.map((point) => point.close.toFloat()),
        name: I.price,
        area: true,
        accessibleSummary: chart.last ? amount(chart.last.close) : "",
      },
    ],
    markers,
    levels,
    xLabels: chart.series.flatMap((point, index) =>
      index === 0 || index === chart.series.length - 1 ? [{ i: index, text: point.date }] : [],
    ),
    tooltip: (index) => ({
      title: chart.series[index]?.date ?? "",
      rows: [
        {
          name: I.price,
          value: chart.series[index] ? amount(chart.series[index].close) : "-",
          amount: true,
        },
      ],
    }),
  };
}
