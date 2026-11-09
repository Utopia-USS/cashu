// Wartość netto w czasie (ab24ab6 core/overview/NetWorthWidget.tsx): Linia / Warstwy, scope, range and step,
// the line or stacked chart with its tooltip, the stacked legend and the 12-month footer facts.
import type { core } from "@cashu/domain";
import { intlLocale } from "@cashu/i18n";
import { S as N } from "@cashu/i18n/core/overview/NetWorthWidget.strings";
import type { AreaLayer, ChartColor, ChartTip, LegendItem } from "@cashu/ui";
import { labelIndices } from "@cashu/ui/charts/geometry";
import { cur, cur0, GROUP, monthYearShort, pctSigned, round0 } from "@cashu/ui-logic/core/format";
import { hideAmount } from "@cashu/ui-logic/core/incognito";
import type { Rich } from "./overviewModel.js";

export type ChartMode = "line" | "stacked";
export type Scope = "total" | "liquid";
export type Step = "monthly" | "weekly" | "daily";

const DAY = 86_400_000;
const STACK_RANK: Readonly<Record<string, number>> = {
  property: 0,
  vehicle: 1,
  money: 2,
  mortgage: 3,
  loan: 4,
};
const NW_COLOR: Readonly<Record<string, ChartColor>> = {
  money: "nw-money",
  property: "nw-property",
  vehicle: "nw-vehicle",
  mortgage: "nw-mortgage",
  loan: "nw-loan",
};
const ranges = (): [string, number | null][] => [
  ["1M", 31],
  ["3M", 92],
  ["6M", 183],
  [N.year, 366],
  ["Max", null],
];

const isoMinus = (iso: string, days: number) =>
  new Date(new Date(iso).getTime() - days * DAY).toISOString().slice(0, 10);

/** The points from which every account of the series is known (`SeriesView.completeFrom`). */
const wholePoints = (view: core.SeriesView): readonly core.SeriesPoint[] => {
  const from = view.completeFrom;
  return from === null ? view.points : view.points.filter((p) => p.date >= from);
};

/** Change over the last 12 months of a series (first whole point on/after a year ago -> last). */
function yearChange(view: core.SeriesView): { abs: number; pct: number | null } | null {
  const points = wholePoints(view);
  if (points.length < 2) return null;
  const last = points[points.length - 1] as core.SeriesPoint;
  const from = isoMinus(last.date, 365);
  const first = points.find((p) => p.date >= from) ?? (points[0] as core.SeriesPoint);
  if (first === last) return null;
  const a = first.value.toFloat();
  const b = last.value.toFloat();
  return { abs: b - a, pct: a ? (b - a) / Math.abs(a) : null };
}

export interface NetWorthWidgetModel {
  title: string;
  mode: {
    label: string;
    items: [string, ChartMode][];
    value: ChartMode;
    onChange(v: ChartMode): void;
  };
  /** null when the total and the liquid series are the same (no property, car or loan). */
  scope: {
    label: string;
    options: { value: Scope; label: string }[];
    value: Scope;
    onChange(v: Scope): void;
  } | null;
  range: {
    label: string;
    items: [string, number | null][];
    value: number | null;
    onChange(v: number | null): void;
  };
  step: { label: string; items: [string, Step][]; value: Step; onChange(v: Step): void };
  foot: Rich[];
  empty: string | null;
  /** A chart point as the hero shows it while the chart is scrubbed: the value, the date and the composition
   * (assets and liabilities of that point); null outside the plotted points. */
  point(i: number): { value: string; date: string; detail: string | null } | null;
  chart:
    | {
        kind: "line";
        label: string;
        values: number[];
        endLabel: string | undefined;
        xLabels: { i: number; text: string }[];
        yFormat(v: number): string;
        tooltip(i: number): ChartTip;
      }
    | {
        kind: "stacked";
        label: string;
        layers: AreaLayer[];
        totals: number[];
        xLabels: { i: number; text: string }[];
        yFormat(v: number): string;
        tooltip(i: number): ChartTip;
        legend: LegendItem[];
      }
    | null;
}

export interface NetWorthUi {
  mode: ChartMode;
  setMode(v: ChartMode): void;
  scope: Scope;
  setScope(v: Scope): void;
  step: Step;
  setStep(v: Step): void;
  range: number | null;
  setRange(v: number | null): void;
}

export function netWorthModel(args: {
  series: core.SeriesView;
  total: core.SeriesView;
  liquid: core.SeriesView;
  ui: NetWorthUi;
}): NetWorthWidgetModel {
  const { series, ui } = args;
  const currency = series.currency;
  // Points before `completeFrom` miss accounts whose data starts later (the first Open Banking import
  // reaches ~90 days back): drawn, they climb to today's value and read as growth.
  const all = wholePoints(series);
  const wholeFrom = series.completeFrom;
  let points = all;
  if (ui.range != null && all.length) {
    const from = isoMinus((all[all.length - 1] as core.SeriesPoint).date, ui.range);
    const cut = all.filter((p) => p.date >= from);
    points = cut.length >= 2 ? cut : all.slice(-2);
  }
  const comps = [...series.components].sort(
    (a, b) => (STACK_RANK[a.key] ?? 9) - (STACK_RANK[b.key] ?? 9),
  );
  const xLabels = labelIndices(points.length, 4).map((i) => ({
    i,
    text: monthYearShort((points[i] as core.SeriesPoint).date),
  }));
  const y = yearChange(args.total);
  // What the total holds beyond the liquid series (property, car, loans): the scope choice and the
  // "accounts only" fact mean something only then.
  const liquidKeys = new Set(args.liquid.components.map((c) => c.key));
  const beyond = args.total.components.filter((c) => !liquidKeys.has(c.key));
  const yl = beyond.length ? yearChange(args.liquid) : null;
  const yFormat = (v: number) =>
    hideAmount(
      new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 0, ...GROUP }).format(
        Math.round(v / 1000) * 1000,
      ),
    );
  const dayText = (iso: string) =>
    new Date(`${iso}T12:00:00`).toLocaleDateString(intlLocale(), {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  const dateOf = (p: core.SeriesPoint) => dayText(p.date);
  const point = (i: number) => {
    const p = points[i];
    if (!p) return null;
    let assets = 0;
    let liabilities = 0;
    for (const v of Object.values(p.components)) {
      const n = v.toFloat();
      if (n >= 0) assets += n;
      else liabilities += n;
    }
    const any = Object.keys(p.components).length > 0;
    return {
      value: cur(p.value.toFloat(), currency),
      date: dateOf(p),
      detail: any
        ? N.composition(
            cur0(Math.round(assets), currency),
            liabilities < 0 ? cur0(Math.round(liabilities), currency) : null,
          )
        : null,
    };
  };
  const tooltip = (i: number): ChartTip => {
    const p = points[i];
    if (!p) return { title: "", rows: [] };
    return {
      title: dateOf(p),
      rows: [
        ...(ui.mode === "stacked"
          ? comps.flatMap((c) => {
              const v = p.components[c.key];
              return v && !v.isZero() ? [{ name: c.label, value: cur(v.toFloat(), currency) }] : [];
            })
          : []),
        { name: N.netWorthLower, value: cur(p.value.toFloat(), currency) },
      ],
    };
  };
  const foot: Rich[] = [];
  if (y)
    foot.push([
      { text: N.months12 },
      {
        text: `${round0(y.abs) > 0 ? "+" : ""}${cur0(round0(y.abs), currency)}${y.pct != null ? ` (${pctSigned(y.pct)})` : ""}`,
        bold: true,
        tone: y.abs >= 0 ? "positive" : "negative",
      },
    ]);
  if (yl && yl.pct != null)
    foot.push([
      { text: N.accountsOnly },
      { text: pctSigned(yl.pct), bold: true, tone: yl.pct >= 0 ? "positive" : "negative" },
    ]);
  if (series.convertedFrom?.length)
    foot.push([{ text: N.convertedFrom(series.convertedFrom.join(", ")) }]);
  if (wholeFrom !== null && all.length >= 2)
    foot.push([{ text: N.historyFrom(dayText(wholeFrom)) }]);
  const last = points[points.length - 1];
  const values = points.map((p) => p.value.toFloat());
  const drawn = all.length >= 2 || (wholeFrom === null && all.length > 0);
  return {
    title: N.title,
    mode: {
      label: N.chartKind,
      items: [
        [N.line, "line"],
        [N.stacked, "stacked"],
      ],
      value: ui.mode,
      onChange: ui.setMode,
    },
    scope: beyond.length
      ? {
          label: N.scope,
          options: [
            {
              value: "total",
              label: N.scopeTotal(beyond.map((c) => c.label.toLocaleLowerCase(intlLocale()))),
            },
            { value: "liquid", label: N.scopeLiquid },
          ],
          value: ui.scope,
          onChange: ui.setScope,
        }
      : null,
    range: { label: N.range, items: ranges(), value: ui.range, onChange: ui.setRange },
    step: {
      label: N.step,
      items: [
        [N.monthly, "monthly"],
        [N.weekly, "weekly"],
        [N.daily, "daily"],
      ],
      value: ui.step,
      onChange: ui.setStep,
    },
    foot,
    empty: drawn
      ? null
      : wholeFrom !== null && series.points.length
        ? N.tooShort(dayText(wholeFrom))
        : N.empty,
    point,
    chart: !drawn
      ? null
      : ui.mode === "line"
        ? {
            kind: "line",
            label: N.lineLabel(currency),
            values,
            endLabel: last ? cur0(Math.round(last.value.toFloat()), currency) : undefined,
            xLabels,
            yFormat,
            tooltip,
          }
        : {
            kind: "stacked",
            label: N.stackedLabel(currency),
            layers: comps.map((c) => ({
              key: c.key,
              name: c.label,
              color: NW_COLOR[c.key] ?? "accent",
              values: points.map((p) => p.components[c.key]?.toFloat() ?? 0),
            })),
            totals: values,
            xLabels,
            yFormat,
            tooltip,
            legend: comps.map((c) => ({
              label: c.label,
              mark: "swatch",
              color: NW_COLOR[c.key] ?? "accent",
            })),
          },
  };
}
