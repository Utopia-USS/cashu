// ValueChartWidget (ab24ab6 v2/Perf.tsx:26-107): portfolio value vs the benchmark bought with the same
// contributions, the range segments, the legend, the chart or its table, the footer facts. Every text and number is
// formatted here; the View only lays it out.
import { intlLocale } from "@cashu/i18n";
import { BENCH_NOTE_L, RANGE_TEXT_L, S } from "@cashu/i18n/investments/v2/Perf.strings";
import type { LegendItem, LineChartProps } from "@cashu/ui";
import { labelIndices } from "@cashu/ui/charts/geometry";
import { GROUP, monthYearShort } from "@cashu/ui-logic/core/format";
import { hideAmount } from "@cashu/ui-logic/core/incognito";
import { dm, money0, pct, pp } from "@cashu/ui-logic/investments/labels";
import { benchmarkLabel, staleBenchmark } from "@cashu/ui-logic/investments/v2/logic";
import type { PerfRange } from "@cashu/ui-logic/investments/v2/types";
import type { InvestmentsHomeData } from "../useInvestmentsHomeData.js";

export interface ValueChartUi {
  range: PerfRange;
  onRange(range: PerfRange): void;
  table: boolean;
  onTable(table: boolean): void;
}

/** One footer item: `lead <b>value</b>` (old FootFacts); `title` on the stale-benchmark label. */
interface FootFact {
  lead: string;
  value?: string;
  title?: string;
}

interface ChartTableColumn {
  label: string;
  num: boolean;
}

type ValueChartBody =
  | { kind: "empty"; text: string; code?: string }
  | { kind: "table"; columns: ChartTableColumn[]; rows: { key: string; cells: string[] }[] }
  | { kind: "chart"; chart: LineChartProps };

export interface ValueChartWidgetProps {
  title: string;
  rangeLabel: string;
  ranges: [string, PerfRange][];
  range: PerfRange;
  onRange(range: PerfRange): void;
  legend: LegendItem[];
  body: ValueChartBody;
  /** Null without a summary (old: no footer). */
  footer: {
    facts: FootFact[];
    toggle: { text: string; pressed: boolean; onToggle(): void };
  } | null;
}

const RANGE_TEXT: Record<PerfRange, string> = RANGE_TEXT_L;
const BENCH_NOTE: Record<string, string> = BENCH_NOTE_L;

const ranges = (): [string, PerfRange][] => [
  ["1M", "1m"],
  ["3M", "3m"],
  ["YTD", "ytd"],
  [S.range1y, "1y"],
  [S.range3y, "3y"],
  ["Max", "max"],
];
const dateLong = (iso: string) =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(intlLocale(), {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
const axisK = (v: number) =>
  hideAmount(
    new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 0, ...GROUP }).format(
      Math.round(v / 1000) * 1000,
    ),
  );

export function valueChartProps(
  data: InvestmentsHomeData,
  ui: ValueChartUi,
): ValueChartWidgetProps {
  const { range } = ui;
  const perf = data.perfChart.data;
  const pts = perf?.points ?? [];
  const bench = perf?.benchmark;
  const benchOk = bench?.status === "ok";
  const c = perf?.base_currency ?? "PLN";
  const s = perf?.summary;
  const last = pts[pts.length - 1];
  const lastV = last ? last.value : null;
  const lastB = last ? last.simulated_value : null;
  const benchName = benchmarkLabel(bench);
  const stale = benchOk ? staleBenchmark(bench) : null;

  const legend: LegendItem[] = [
    { label: S.portfolio, mark: "main", stacked: true },
    ...(benchOk ? [{ label: S.sameContributions(benchName, c), mark: "bench" as const }] : []),
  ];

  let body: ValueChartBody;
  if (!perf || pts.length < 2) {
    body =
      perf === null
        ? { kind: "empty", text: S.noHistoryRun, code: "cashu invest backfill" }
        : { kind: "empty", text: S.tooLittleHistory };
  } else if (ui.table) {
    const columns: ChartTableColumn[] = [
      { label: S.thDate, num: false },
      { label: S.thPortfolio, num: true },
      ...(benchOk ? [{ label: benchName, num: true }] : []),
      { label: "TWR", num: true },
      ...(benchOk ? [{ label: S.thDifference, num: true }] : []),
    ];
    const rows = labelIndices(pts.length, 13).flatMap((i) => {
      const p = pts[i];
      if (!p) return [];
      const cells = [
        p.date,
        money0(p.value, c),
        ...(benchOk ? [money0(p.simulated_value, c)] : []),
        pct(p.twr, true),
        ...(benchOk
          ? [p.twr != null && p.benchmark != null ? pp((p.twr - p.benchmark) * 100) : "-"]
          : []),
      ];
      return [{ key: p.date, cells }];
    });
    body = { kind: "table", columns, rows };
  } else {
    const xLabels = labelIndices(pts.length, 5).map((i) => {
      const date = pts[i]?.date ?? "";
      return { i, text: range === "1m" ? dm(date) : monthYearShort(date) };
    });
    body = {
      kind: "chart",
      chart: {
        label: S.valueChartLabel(benchOk ? benchName : null, RANGE_TEXT[range]),
        height: 230,
        padL: 56,
        padR: 150,
        yFormat: axisK,
        valueKind: "share",
        xLabels,
        series: [
          ...(benchOk
            ? [
                {
                  values: pts.map((p) => p.simulated_value),
                  tone: "bench" as const,
                  color: "bench" as const,
                  endLabel: lastB != null ? `${benchName} ${money0(lastB, c)}` : undefined,
                },
              ]
            : []),
          {
            values: pts.map((p) => p.value),
            color: "accent",
            area: true,
            endLabel: lastV != null ? S.portfolioEnd(money0(lastV, c)) : undefined,
          },
        ],
        tooltip: (i) => {
          const p = pts[i];
          if (!p) return { title: "", rows: [] };
          const diff = p.twr != null && p.benchmark != null ? (p.twr - p.benchmark) * 100 : null;
          return {
            title: dateLong(p.date),
            rows: [
              { name: S.portfolio, value: money0(p.value, c) },
              ...(benchOk && p.simulated_value != null
                ? [{ name: benchName, value: money0(p.simulated_value, c) }]
                : []),
              ...(benchOk && diff != null
                ? [{ name: S.difference, value: pp(diff), muted: true }]
                : []),
            ],
          };
        },
      },
    };
  }

  let footer: ValueChartWidgetProps["footer"] = null;
  if (s) {
    const facts: (FootFact | false)[] = [
      { lead: `${RANGE_TEXT[range]} TWR `, value: pct(s.twr, true) },
      stale != null && { lead: stale.label, title: stale.title },
      benchOk &&
        stale == null &&
        bench?.twr != null && { lead: `${S.benchmark} `, value: pct(bench.twr, true) },
      benchOk &&
        stale == null &&
        bench?.excess_twr != null && {
          lead: `${S.difference} `,
          value: pp(bench.excess_twr * 100),
        },
      s.xirr != null && { lead: "XIRR ", value: pct(s.xirr) },
      s.net_contributions != null && {
        lead: `${S.contributionsIn(RANGE_TEXT[range])} `,
        value: money0(s.net_contributions, c),
      },
      !benchOk && bench != null && { lead: BENCH_NOTE[bench.status] ?? S.benchUnavailable },
    ];
    footer = {
      facts: facts.filter((f): f is FootFact => f !== false),
      toggle: {
        text: ui.table ? S.chart : S.table,
        pressed: ui.table,
        onToggle: () => ui.onTable(!ui.table),
      },
    };
  }

  return {
    title: S.valueVsBench,
    rangeLabel: S.range,
    ranges: ranges(),
    range,
    onRange: ui.onRange,
    legend,
    body,
    footer,
  };
}
