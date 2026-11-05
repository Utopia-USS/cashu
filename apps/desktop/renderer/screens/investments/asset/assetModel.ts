// The asset detail of the Python app (ab24ab6 v2/AssetPage.tsx AssetDetail, lines 86-411) as data for the pure
// view: header (identity, price, facts, actions, meta line, lots), the price chart with its levels and markers, Teza,
// Rekomendacja, Alerty, Sygnały i decyzje and Dlaczego obserwuję. Every derivation is the old one, moved out of
// the JSX unchanged; the view only lays it out.

import { intlLocale } from "@cashu/i18n";
import { C } from "@cashu/i18n/core/common.strings";
import { S, THRESHOLD_WORD } from "@cashu/i18n/investments/v2/AssetPage.strings";
import { S as SG } from "@cashu/i18n/investments/v2/SegmentSelect.strings";
import type {
  ChartTip,
  HintChipProps,
  InstTileProps,
  LegendItem,
  Level,
  SelectOption,
} from "@cashu/ui";
import { labelIndices } from "@cashu/ui/charts/geometry";
import { monthYearShort } from "@cashu/ui-logic/core/format";
import { hideAmount } from "@cashu/ui-logic/core/incognito";
import {
  accountLabel,
  bucketLabel,
  dmy,
  ENTRY_TYPE,
  micName,
  money,
  money0,
  pct,
  qty,
  wdm,
} from "@cashu/ui-logic/investments/labels";
import type { Hint, Thesis } from "@cashu/ui-logic/investments/types";
import {
  assetTimeline,
  averageCost,
  FRESH_LABEL,
  freshOf,
  freshReasonLines,
  type HeaderMetaItem,
  headerMeta,
  hintChip,
  hintCls,
  hintLine,
  instName,
  knownHints,
  latestThesis,
  lotRows,
  openRows,
  PLAN_PATH,
  planLabel,
  polarityOf,
  price as priceText,
  type SigState,
  STATE_LABEL,
  signalFact,
  stateOf,
  type TlRow,
  tlDate,
  weekChange,
} from "@cashu/ui-logic/investments/v2/logic";
import { isResearchKind, signalNoteId } from "@cashu/ui-logic/investments/v2/research/logic";
import { canonKey, SEGMENTS, segmentLabel } from "@cashu/ui-logic/investments/v2/research/segments";
import type {
  Alert,
  PositionChart,
  PositionDetail,
  PositionV2,
  SignalV2,
  WatchItem,
} from "@cashu/ui-logic/investments/v2/types";
import {
  type Age,
  type FactParts,
  factParts,
  longText,
  type SignalsCtx,
  signalAge,
} from "../../signals/signalsModel.js";

export type AssetMode = "drawer" | "page";
export type Tone = "positive" | "negative";

/** `6M / 1R / 2R / Max` (AssetPage.tsx:47). */
const monthItems = (): [string, number][] => [
  ["6M", 6],
  [S.year1, 12],
  [S.year2, 24],
  ["Max", 120],
];

/** The zloty sign as Polish formatting writes it (the old pattern's literal sign). */
const ZL =
  new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" })
    .formatToParts(0)
    .find((part) => part.type === "currency")?.value ?? "PLN";
const SYMBOL_END = new RegExp(`\\s?(${ZL}|€|\\$)$`);
const SYMBOL_START = new RegExp(`^(?:[A-Z]{3}|[A-Z]{0,2}\\$|€|${ZL})\\s?`);
/** A formatted price without its currency symbol (the chart's level labels, AssetPage.tsx:56). */
const bareNumber = (s: string) => s.replace(SYMBOL_END, "").replace(SYMBOL_START, "");
const num2 = (v: number) =>
  hideAmount(
    v.toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  );
const toneOf = (v: number | null | undefined): Tone => ((v ?? 0) >= 0 ? "positive" : "negative");

export interface AssetInputs {
  id: number;
  mode: AssetMode;
  today: string;
  /** Positions of the Home's account filter (old `positions.positions`). */
  positions: PositionV2[];
  alerts: Alert[];
  watch: WatchItem[];
  /** The old SignalsCtx (accounts, totals, the last good run, alerts by id, names). */
  ctx: SignalsCtx;
  detail: PositionDetail | null;
  chart: PositionChart | null;
  /** Every signal of the profile (old `getSignalsV2("all")`). */
  signals: SignalV2[];
  /** Held anywhere in the profile (old `isHeld(useInstState(), id)`). */
  heldAnywhere: boolean;
  /** The ticker tile marks (old InstTile via instState). */
  tile: Pick<InstTileProps, "monogram" | "plan" | "freshness" | "health" | "faded">;
  /** A name seen before the detail loaded (old NAMES map). */
  knownName: string | null;
  /** Phone width (max 640px): room for the level labels, fewer date labels. */
  small: boolean;
  lotsOpen: boolean;
  months: number;
}

export interface OpenSignalRowModel {
  id: number;
  polarity: string;
  fact: FactParts;
  title: string;
  /** Research signals: `notatka` opens the note. */
  note: { noteId: number | null; segment: string | null } | null;
  age: Age;
}

interface LotRowModel {
  key: string;
  date: string;
  account: string | null;
  quantity: string;
  price: string;
  result: { text: string; tone: Tone };
  resultPct: { text: string; tone: Tone };
}

/** The header hint chip (hints.tsx HintChip with `all`): the main hint, every hint in its title. */
function headerHint(hints: Hint[], held: boolean): HintChipProps | null {
  const h = hints[0];
  if (!h) return null;
  const chip = hintChip(h, held);
  if (!chip) return null;
  const lines = hints.map((x) => hintLine(x, held)).filter(Boolean);
  return { code: h.code, text: chip, title: lines.join("\n"), severity: hintCls(h.severity) };
}

/** The topic select of the header meta line (SegmentSelect.tsx). */
export function segmentModel(inst: { segment?: string | null; segment_source?: string | null }) {
  const segment = canonKey(inst.segment ?? null);
  const source = inst.segment_source ?? null;
  const explicit = source != null && source !== "auto" && !!segment;
  const autoLabel = source === "auto" && segment ? segmentLabel(segment) : null;
  const value = explicit && segment ? segment : "";
  const options: SelectOption[] = [
    { value: "", label: autoLabel ? `auto · ${autoLabel}` : SG.none },
    ...SEGMENTS.filter((s) => s.group === "asset").map((s) => ({
      value: s.key,
      label: s.label,
      group: SG.assetClasses,
    })),
    ...SEGMENTS.filter((s) => s.group === "sector").map((s) => ({
      value: s.key,
      label: s.label,
      group: SG.sectors,
    })),
  ];
  return { segment, source, value, autoLabel, options };
}
export const segmentTitle = (
  m: ReturnType<typeof segmentModel>,
  value: string,
): string | undefined =>
  m.autoLabel
    ? SG.autoTitle
    : m.source === "agent" && value === m.segment
      ? SG.setByClaude
      : undefined;

export function assetModel(o: AssetInputs) {
  const { id, detail, chart } = o;
  const pos = o.positions.find((p) => String(p.instrument.id) === String(id)) ?? null;
  const w = o.watch.find((x) => x.instrument_id === id) ?? null;
  const inst = pos?.instrument ?? detail?.instrument ?? w?.instrument ?? null;
  const name = inst ? instName(inst) : (o.knownName ?? chart?.label ?? S.instrument(id));
  const mine = o.alerts.filter((a) => a.instrument_id === id);
  const live = mine.filter(
    (a) => a.status === "active" || a.status === "triggered" || a.status === "snoozed",
  );
  const signals = o.signals.filter((s) => s.instrument_id === id);
  const undecided = openRows(signals);
  const state: SigState | null = stateOf(undecided.map(polarityOf));
  const theses: Thesis[] = detail?.theses ?? [];
  const thesis = latestThesis(theses);
  const c = pos?.price_currency ?? chart?.currency ?? inst?.currency ?? "PLN";
  const series = chart?.series ?? [];
  const closes = series.map((p) => p.close);
  const last = chart?.last?.close ?? pos?.price ?? w?.price?.close ?? null;
  const high = chart?.high_52w ?? null;
  const fromHigh = high && last ? last / high - 1 : null;
  const wk = weekChange(series.length ? series.slice(-30) : (w?.closes_30d ?? null));
  const lots = lotRows(pos?.lots ?? []);
  const firstLot = lots.rows[0];
  const accounts = o.ctx.accounts;
  const acc =
    pos?.accounts.length === 1 ? accounts.find((a) => a.id === pos.accounts[0]?.account_id) : null;
  const fees = (detail?.transactions ?? []).reduce((s, t) => s + (t.fee || 0), 0);
  const meta: HeaderMetaItem[] = pos
    ? headerMeta({
        lots: lots.rows.length,
        txns: detail ? detail.transactions.length : null,
        dividends: pos.dividends,
        fees,
        currency: c,
      })
    : [];
  // Held: a decision without an open signal is fine (position decisions).
  const canDecide = undecided.length > 0 || !!pos;
  const held = !!pos || o.heldAnywhere;
  const showSegment = held || !!w;
  const pLabel = (v: string | null) => planLabel(v, held);
  const plan = inst?.plan && pLabel(inst.plan) ? inst.plan : null;
  const hints = knownHints(detail?.hints ?? pos?.hints ?? w?.hints ?? [], held);
  const fresh = plan ? freshOf(inst?.plan_freshness) : null;
  const reasons = fresh ? freshReasonLines(inst?.plan_freshness, { hints, alerts: mine }) : [];
  const names = new Map(
    o.positions.map((p) => [Number(p.instrument.id), instName(p.instrument)] as [number, string]),
  );

  // ---- chart levels, markers, foot facts (AssetPage.tsx:135-166) ----
  const levels: Level[] = [];
  for (const a of live) {
    if (
      (a.kind === "price_below" || a.kind === "price_above") &&
      typeof a.params.level === "number"
    )
      levels.push({
        y: a.params.level,
        kind: a.source === "agent" ? "agent" : "alert",
        label: `${a.source === "agent" ? S.agentAlert : S.alert} · ${a.kind === "price_below" ? S.below : S.above} ${bareNumber(priceText(a.params.level, c))}`,
      });
  }
  for (const t of chart?.thresholds ?? []) {
    const word = (THRESHOLD_WORD as Record<string, string | undefined>)[t.kind] ?? S.rule;
    levels.push({
      y: t.y,
      kind: "rule",
      muted: true,
      label: S.threshold(
        word,
        t.kind === "gain_from_cost" ? "+" : "-",
        Math.round(t.threshold * 100),
        t.basis === "cost",
        num2(t.y),
      ),
    });
  }
  if (high != null)
    levels.push({ y: high, kind: "rule", muted: true, label: `${S.high52} · ${num2(high)}` });
  const cost = chart?.cost?.average;
  if (cost != null && pos?.valuation_mode === "market")
    levels.push({ y: cost, kind: "cost", muted: true, label: `${S.avgCost} · ${num2(cost)}` });
  const first = series[0];
  const markers = (chart?.markers ?? [])
    .filter((m) => series.length > 1 && first !== undefined && m.date >= first.date)
    .map((m) => {
      let i = series.findIndex((p) => p.date >= m.date);
      if (i < 0) i = series.length - 1;
      return { i, kind: (m.type === "sell" ? "sell" : "buy") as "buy" | "sell" };
    });
  const vol30 = (() => {
    const xs = closes.slice(-31);
    if (xs.length < 10) return null;
    const r = xs.slice(1).map((v, i) => Math.log(v / (xs[i] ?? v)));
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  })();
  const nearest = live
    .filter((a) => a.kind.startsWith("price_") && typeof a.params.level === "number" && last)
    .map((a) => ({ a, d: (a.params.level as number) / (last as number) - 1 }))
    .sort((x, y) => Math.abs(x.d) - Math.abs(y.d))[0];
  const legend: LegendItem[] = [
    { label: S.legendPrice, mark: "main" },
    ...(levels.some((l) => l.kind === "alert")
      ? [{ label: S.legendAlerts, mark: "alert" as const }]
      : []),
    ...(levels.some((l) => l.kind === "agent")
      ? [{ label: S.agentAlert, mark: "agent" as const }]
      : []),
    ...((chart?.thresholds.length ?? 0) > 0
      ? [{ label: S.legendRules, mark: "rule" as const }]
      : []),
    ...(levels.some((l) => l.kind === "cost") ? [{ label: S.avgCost, mark: "cost" as const }] : []),
    ...(markers.some((m) => m.kind === "buy")
      ? [{ label: S.legendBuys, mark: "buy" as const }]
      : []),
    ...(markers.some((m) => m.kind === "sell")
      ? [{ label: S.legendSells, mark: "sell" as const }]
      : []),
  ];
  const foot: { label: string; value: string }[] = [
    ...(high != null ? [{ label: S.high52, value: money(high, c) }] : []),
    ...(closes.length > 1 ? [{ label: S.low, value: money(Math.min(...closes), c) }] : []),
    ...(vol30 != null ? [{ label: S.vol30, value: pct(vol30) }] : []),
    ...(nearest
      ? [
          {
            label: S.toAlert(priceText(nearest.a.params.level as number, c)),
            value: pct(nearest.d, true),
          },
        ]
      : []),
  ];
  const height = o.mode === "drawer" ? 260 : 300;
  const chartBody =
    series.length < 2
      ? {
          kind: "empty" as const,
          text:
            pos?.valuation_mode === "cost"
              ? S.costValued
              : pos?.valuation_mode === "manual"
                ? S.manualValued
                : S.tooFewQuotes,
        }
      : {
          kind: "chart" as const,
          label: S.chartLabel(name),
          height,
          padL: o.small ? 36 : 46,
          padR: o.small ? 150 : 200,
          values: closes,
          endLabel: last != null ? money(last, c) : undefined,
          levels,
          markers,
          xLabels: labelIndices(series.length, o.small ? 3 : 5).map((i) => ({
            i,
            text: monthYearShort(series[i]?.date ?? ""),
          })),
          yFormat: (v: number) =>
            hideAmount(v.toLocaleString(intlLocale(), { maximumFractionDigits: v >= 100 ? 0 : 2 })),
          tooltip: (i: number): ChartTip => ({
            title: dmy(series[i]?.date ?? null),
            rows: [{ name: S.legendPrice, value: money(series[i]?.close ?? null, c) }],
          }),
        };

  // ---- timeline (AssetPage.tsx:173-176, 369-390) ----
  const ctxNames = { total: o.ctx.total, base: o.ctx.base, names };
  const timeline: TlRow[] = assetTimeline({
    signals,
    decisions: detail?.decisions ?? [],
    theses,
    txns: detail?.transactions ?? [],
    ctx: ctxNames,
    currency: c,
  });
  const yearNow = o.today.slice(0, 4);
  const open: OpenSignalRowModel[] = undecided.map((s) => {
    const research = isResearchKind(s.kind) || s.source === "research";
    return {
      id: s.id,
      polarity: polarityOf(s),
      fact: factParts(signalFact(s)),
      title: longText(s, o.ctx),
      note: research
        ? {
            noteId: signalNoteId(s),
            segment: typeof s.payload.segment === "string" ? s.payload.segment : null,
          }
        : null,
      age: signalAge(s, o.ctx),
    };
  });

  const avgCost = pos ? averageCost(pos, o.ctx.base) : null;
  const sub = [
    acc
      ? accountLabel(acc, accounts)
      : pos
        ? S.accounts(pos.accounts.length)
        : w
          ? S.watched
          : null,
    firstLot ? S.since(dmy(firstLot.open_date)) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const lotTable: LotRowModel[] = lots.rows.map((l, k) => {
    const a = accounts.find((x) => x.id === l.account_id);
    return {
      key: `${l.open_date}:${l.account_id}:${k}`,
      date: dmy(l.open_date),
      account: lots.multi && a ? accountLabel(a, accounts) : null,
      quantity: qty(l.quantity),
      price: l.unit_cost != null ? money(l.unit_cost, l.currency) : "-",
      result: { text: money0(l.result, l.currency, true), tone: toneOf(l.result) },
      resultPct: { text: pct(l.resultPct, true), tone: toneOf(l.resultPct) },
    };
  });
  return {
    id,
    name,
    held: !!pos,
    heldAnywhere: held,
    thesis,
    instrumentId: inst?.id ?? id,
    instrumentLabel: inst?.label || name,
    position: pos,
    watchItem: w,
    live,
    head: {
      tile: inst ? o.tile : null,
      labelSub: inst
        ? [inst.symbol !== name ? inst.symbol : null, micName(inst.mic), bucketLabel(pos?.bucket)]
            .filter(Boolean)
            .join(" · ")
        : "",
      sub,
      state: state ? { state, label: STATE_LABEL[state] } : null,
      hint: hints.length > 0 ? headerHint(hints, held) : null,
      price: last != null ? money(last, c) : "-",
      week: wk != null ? { text: `${pct(wk, true)} ${S.week}`, tone: toneOf(wk) } : null,
      date: chart?.last ? wdm(chart.last.date) : "",
      fromHigh:
        fromHigh != null
          ? { text: pct(fromHigh), tone: (fromHigh < 0 ? "negative" : "positive") as Tone }
          : null,
      facts: pos
        ? {
            value: money(pos.value, o.ctx.base),
            valueDetail: pos.weight != null ? `${pct(pos.weight)} ${S.ofPortfolio}` : null,
            result: {
              text: money0(pos.unrealized, o.ctx.base, true),
              tone: toneOf(pos.unrealized),
            },
            resultPct: pct(pos.unrealized_pct, true),
            avgCost: avgCost ? money(avgCost.value, avgCost.currency) : "-",
            quantity: qty(pos.quantity),
          }
        : null,
      watch: held ? null : w ? ("watching" as const) : ("watch" as const),
      canTxn: !!pos,
      canDecide,
      meta,
      segment: showSegment && inst ? segmentModel(inst) : null,
      showMeta: !!pos || (showSegment && !!inst),
      lots: pos && o.lotsOpen && lots.rows.length > 1 ? lotTable : null,
    },
    chart: {
      legend,
      body: chartBody,
      foot,
      currency: c,
      months: o.months,
      monthItems: monthItems(),
    },
    thesisW:
      pos || w
        ? {
            entryType: thesis?.entry_type
              ? (ENTRY_TYPE[thesis.entry_type] ?? thesis.entry_type)
              : null,
            action: thesis ? C.edit : C.add,
            parts: thesis
              ? [
                  { key: "entry", label: S.entry, text: thesis.thesis },
                  { key: "inv", label: S.invalidation, text: thesis.invalidation },
                  { key: "exit", label: S.exitPlan, text: thesis.exit_plan },
                  { key: "size", label: S.sizePlan, text: thesis.size_plan },
                ].filter((p) => !!p.text)
              : null,
          }
        : null,
    recW: plan
      ? {
          tint:
            fresh === "out"
              ? ("negative" as const)
              : fresh === "maybe"
                ? ("warning" as const)
                : undefined,
          date: inst?.plan_at ? dmy(inst.plan_at) : null,
          fresh: fresh ? { text: FRESH_LABEL[fresh], out: fresh === "out" } : null,
          label: pLabel(plan),
          path: PLAN_PATH[plan] ?? null,
          reason: inst?.plan_reason ?? null,
          reasons,
          freshKey: fresh,
        }
      : null,
    watchW: !pos && w ? { note: w.note } : null,
    open,
    timeline: timeline.map((e) => ({ ...e, date: tlDate(e.at, yearNow) })),
  };
}
export type AssetModel = ReturnType<typeof assetModel>;
