// ValueChartWidget (ab24ab6 v2/Perf.tsx:26-107, laid out as design V5): portfolio value vs the benchmark bought with
// the same contributions, the range segments and the chart | table toggle, the legend line (portfolio, benchmark with
// its return, difference, the benchmark status), the chart or its table, then the KPI strip (the hero facts with the
// range's TWR / XIRR and contributions). Every text and number is formatted here; the View only lays it out.
import { intlLocale } from "@cashu/i18n";
import { BENCH_NOTE_L, RANGE_TEXT_L, S } from "@cashu/i18n/investments/v2/Perf.strings";
import type { LineChartProps } from "@cashu/ui";
import { labelIndices } from "@cashu/ui/charts/geometry";
import { GROUP, monthYearShort } from "@cashu/ui-logic/core/format";
import { bananaMoney, hideAmount } from "@cashu/ui-logic/core/incognito";
import { dm, money0, pct, pp } from "@cashu/ui-logic/investments/labels";
import { benchmarkLabel, staleBenchmark } from "@cashu/ui-logic/investments/v2/logic";
import type { PerfRange } from "@cashu/ui-logic/investments/v2/types";
import type { InvestmentsHomeData } from "../useInvestmentsHomeData.js";

export interface ValueChartUi {
  range: PerfRange;
  onRange(range: PerfRange): void;
  table: boolean;
  onTable(table: boolean): void;
  /** The hero facts (year to date, unrealized, drawdown, contributions) for the KPI strip; none = no strip. */
  facts?: readonly ChartFact[];
}

type Tone = "positive" | "negative";

/** One legend entry: a series mark (or none), its label and an optional bold figure. */
interface LegendEntry {
  key: string;
  label: string;
  mark: "main" | "bench" | null;
  value?: string;
  tone?: Tone;
}

/** A sub line of a KPI cell: plain text parts, some toned. */
export interface KpiLine {
  key: string;
  parts: { text: string; tone?: Tone }[];
  title?: string;
}

/** One cell of the KPI strip under the chart (the hero facts of the old strip). */
export interface KpiCell {
  key: string;
  label: string;
  value: string;
  tone?: Tone;
  title?: string;
  /** Progress 0..1 under the value (contributions against the plan). */
  bar?: number;
  lines: KpiLine[];
}

/** A hero fact as the screen hands it over (homeModel.ts HeroFact). */
interface ChartFact {
  key: string;
  label: string;
  value: string;
  tone?: Tone;
  title?: string;
  bar?: number;
  detail?: string;
  bench?: { lead: string; pp: { text: string; tone: Tone } | null };
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
  /** The benchmark in words next to the title (`MSCI ACWI in PLN, same contributions`); null without one. */
  sub: string | null;
  rangeLabel: string;
  ranges: [string, PerfRange][];
  range: PerfRange;
  onRange(range: PerfRange): void;
  /** The chart | table toggle (null without a summary, like the old footer). */
  toggle: { text: string; pressed: boolean; onToggle(): void } | null;
  legend: LegendEntry[];
  /** The benchmark's state at the legend's right end: out of date (warning, with its title) or why it is missing. */
  status: { text: string; title?: string; warn: boolean } | null;
  body: ValueChartBody;
  /** The KPI strip under the chart, inside the card. */
  kpis: KpiCell[];
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
const axisK = (v: number, currency: string) =>
  bananaMoney(v, currency) ??
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

  const toneOf = (v: number | null | undefined): Tone | undefined =>
    v == null || v === 0 ? undefined : v > 0 ? "positive" : "negative";
  const benchFresh = benchOk && stale == null;
  const legend: LegendEntry[] = [
    { key: "portfolio", label: S.thPortfolio, mark: "main" },
    ...(benchOk
      ? [
          {
            key: "bench",
            label: benchName,
            mark: "bench" as const,
            ...(benchFresh && bench?.twr != null ? { value: pct(bench.twr, true) } : {}),
          },
        ]
      : []),
    ...(benchFresh && bench?.excess_twr != null
      ? [
          {
            key: "difference",
            label: S.thDifference,
            mark: null,
            value: pp(bench.excess_twr * 100),
            ...(toneOf(bench.excess_twr) ? { tone: toneOf(bench.excess_twr) } : {}),
          },
        ]
      : []),
  ];
  const status: ValueChartWidgetProps["status"] =
    stale != null
      ? { text: stale.label, title: stale.title, warn: true }
      : !benchOk && bench != null
        ? { text: BENCH_NOTE[bench.status] ?? S.benchUnavailable, warn: false }
        : null;

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
        height: 250,
        padL: 56,
        padR: 150,
        yFormat: (v: number) => axisK(v, c),
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

  // The old footer's figures: the range's TWR and XIRR under Year to date, its net contributions under
  // Contributions; the benchmark's return, the difference and its status went to the legend line.
  const rangeLine: KpiLine | null = s
    ? {
        key: "range",
        parts: [
          { text: `${RANGE_TEXT[range]} TWR ` },
          { text: pct(s.twr, true), ...(toneOf(s.twr) ? { tone: toneOf(s.twr) } : {}) },
          ...(s.xirr != null ? [{ text: ` · XIRR ${pct(s.xirr)}` }] : []),
        ],
      }
    : null;
  const contribLine: KpiLine | null =
    s?.net_contributions != null
      ? {
          key: "range-contributions",
          parts: [
            { text: `${S.contributionsIn(RANGE_TEXT[range])} ${money0(s.net_contributions, c)}` },
          ],
        }
      : null;
  const kpis: KpiCell[] = (ui.facts ?? []).map((f) => {
    const own: KpiLine | null = f.bench
      ? {
          key: "bench",
          parts: [
            { text: f.bench.lead },
            ...(f.bench.pp
              ? [{ text: " · " }, { text: f.bench.pp.text, tone: f.bench.pp.tone }]
              : []),
          ],
        }
      : f.detail
        ? { key: "detail", parts: [{ text: f.detail }] }
        : null;
    const extra = f.key === "ytd" ? rangeLine : f.key === "contributions" ? contribLine : null;
    return {
      key: f.key,
      label: f.label,
      value: f.value,
      ...(f.tone ? { tone: f.tone } : {}),
      ...(f.title ? { title: f.title } : {}),
      ...(f.bar != null ? { bar: f.bar } : {}),
      // Year to date leads with the range figures (design V5: `TWR 12m +1.7 % · XIRR 2.4 %`), then its benchmark.
      lines: (f.key === "ytd" ? [extra, own] : [own, extra]).filter((l): l is KpiLine => l != null),
    };
  });

  return {
    title: S.valueVsBench,
    sub: benchOk ? S.sameContributions(benchName, c) : null,
    rangeLabel: S.range,
    ranges: ranges(),
    range,
    onRange: ui.onRange,
    toggle: s
      ? {
          text: ui.table ? S.chart : S.table,
          pressed: ui.table,
          onToggle: () => ui.onTable(!ui.table),
        }
      : null,
    legend,
    status,
    body,
    kpis,
  };
}
