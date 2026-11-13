// The position page's hook: one instrument live from the vault through the asset query (the price
// history of the chosen range with the owner's levels and trades, the position, the thesis and the
// decisions), its signals from the signals query and its research notes. Chart values are the store's
// exact Decimals converted to plot numbers here; the owner's quantity and average cost are masked
// while amounts are hidden and the levels drawn from that cost are left off the chart (their position
// on the public price axis would give it away), public prices never are.
// Navigation stays in the route.
import { type core, D, Decimal, type IsoDate, Money } from "@cashu/domain";
import { S as Asset, THRESHOLD_WORD } from "@cashu/i18n/investments/v2/AssetPage.strings";
import { formatDecimalValue } from "@cashu/i18n/values";
import { profileIdentity } from "@cashu/store/core/profile";
import { useQuery } from "@cashu/store-react";
import { type LineChartProps, type TagTone, useUiEnv } from "@cashu/ui/native";
import { useState } from "react";
import { deviceTimeZone } from "../../services/investments";
import { useServices } from "../../services/ServicesProvider";
import { ACTION, RELATION } from "../alert/Alert.strings";
import {
  averageCostOf,
  axisDayText,
  dayOf,
  dayText,
  MASK,
  momentText,
  ownPriceText,
  priceText,
  ratioText,
} from "../alert/display";
import { isAcknowledgement, signalTitle } from "../alert/useAlertSheet";
import type { DisplayEnv } from "../today/display";
import { EXCHANGE, S } from "./Position.strings";

type PositionRange = "1m" | "3m" | "1y" | "max";

/** Months of history per range ("max": everything the device has). */
const MONTHS: Readonly<Record<PositionRange, number>> = { "1m": 1, "3m": 3, "1y": 12, max: 600 };
/** Sessions in a week, for "this week". */
const WEEK_SESSIONS = 5;
/** Research notes listed under the position. */
const NOTES_SHOWN = 5;
const OPEN = new Set(["active", "acknowledged"]);
const RELATION_TONES: Readonly<Record<string, TagTone>> = {
  weakens: "negative",
  invalidates: "negative",
  supports: "positive",
  fulfills: "positive",
};

/** Most fraction digits a quantity shows (crypto has 8). */
const QUANTITY_DIGITS = 8;

/**
 * A held quantity in its own scale: fractional holdings (0.25 BTC, 1.5 fund units) keep their
 * digits, trailing zeros are trimmed and at most eight fraction digits are shown.
 */
export function quantityText(quantity: Decimal, locale: string): string {
  const capped =
    quantity.exp < -QUANTITY_DIGITS
      ? quantity.rescale(-QUANTITY_DIGITS, "ROUND_HALF_UP")
      : quantity;
  const digits = capped.isZero() ? 0 : Math.max(0, -capped.normalize().exp);
  return formatDecimalValue(capped, locale, { fractionDigits: digits }).text;
}

export type PositionRow =
  | {
      readonly kind: "signal";
      readonly key: string;
      readonly title: string;
      readonly sub: string;
      readonly tag: { readonly text: string; readonly tone: TagTone };
      /** Null once decided: the row only notes it. */
      readonly onPress: (() => void) | null;
    }
  | {
      readonly kind: "note";
      readonly key: string;
      readonly title: string;
      readonly sub: string;
      readonly tag: { readonly text: string; readonly tone: TagTone };
      readonly onPress: () => void;
    }
  | {
      readonly kind: "decision";
      readonly key: string;
      readonly title: string;
      readonly sub: string;
    };

export type PositionState =
  | { readonly kind: "missing"; readonly reason: "unknown" | "unavailable" }
  | {
      readonly kind: "ready";
      /** The instrument's name (the native header). */
      readonly title: string;
      readonly hero: {
        readonly ticker: string;
        /** An open action signal waits for a decision: the ticker gets the risk ring. */
        readonly risk: boolean;
        readonly name: string;
        /** "Warsaw · IKE". */
        readonly place: string | null;
        /** "7.5% of the portfolio". */
        readonly share: string | null;
        /** The position's value in the base currency; null when not held. */
        readonly value: Money | null;
        /** The result against cost and the week's move, as ratios. */
        readonly result: Decimal | null;
        readonly week: Decimal | null;
        /** "PLN 214.60 a share" (a public price). */
        readonly perUnit: string | null;
        /** "29% under the 52-week high". */
        readonly fromHigh: string | null;
      };
      readonly chart: LineChartProps | null;
      readonly range: { readonly value: PositionRange; onChange(range: PositionRange): void };
      /** Quantity and average cost: the owner's own figures, masked while amounts are hidden. */
      readonly facts: { readonly quantity: string; readonly averageCost: string | null } | null;
      readonly thesis: {
        readonly why: string | null;
        readonly wrongIf: string | null;
        readonly sizePlan: string | null;
        readonly exitPlan: string | null;
      } | null;
      readonly rows: readonly PositionRow[];
    };

export function usePositionScreen(args: {
  readonly gid: string;
  readonly lang: core.UiLang;
  readonly today: IsoDate;
  readonly now: string;
  openAlert(signal: string): void;
  openNote(note: string): void;
}): PositionState {
  const ui = useUiEnv();
  const { locale } = ui;
  const env: DisplayEnv = { locale, privacy: ui.privacy, bananas: ui.bananas ?? null };
  const { moneyQueries } = useServices();
  const { today, lang } = args;
  const [range, setRange] = useState<PositionRange>("3m");
  const asset = useQuery(moneyQueries.investments.asset, {
    today,
    lang,
    instrument: args.gid,
    months: MONTHS[range],
  });
  const screen = useQuery(moneyQueries.investments.signals, {
    now: args.now,
    today,
    timeZone: deviceTimeZone(),
    lang,
    privacy: false,
  });
  const research = useQuery(moneyQueries.investments.research.asset, {
    today,
    lang,
    instrument: args.gid,
  });
  const profile = useQuery(profileIdentity);
  if (asset.status === "refused" || asset.status === "none")
    return { kind: "missing", reason: "unknown" };
  if (asset.status !== "ready") return { kind: "missing", reason: "unavailable" };

  const { detail, chart } = asset;
  const instrument = detail.instrument;
  const position = detail.position;
  const name = instrument.name ?? instrument.symbol ?? instrument.label;
  const currency = chart?.currency ?? instrument.currency;
  const base = profile?.baseCurrency ?? null;
  const unit = instrument.asset_class === "equity" ? S.perShare : S.perUnit;

  // Hero.
  const exchange =
    instrument.mic === null
      ? null
      : ((EXCHANGE as Record<string, string | undefined>)[instrument.mic] ?? instrument.mic);
  const accounts = position?.accounts ?? [];
  const account =
    accounts.length === 0
      ? null
      : accounts.length === 1
        ? (accounts[0]?.account_name ?? null)
        : S.accounts(accounts.length);
  const place =
    exchange !== null && account !== null
      ? S.exchangeAccount(exchange, account)
      : (exchange ?? account);
  const closes = position?.closes_30d ?? [];
  const lastClose = closes.at(-1)?.close;
  const weekAgo = closes.at(-1 - WEEK_SESSIONS)?.close;
  const week =
    lastClose !== undefined && weekAgo !== undefined && !weekAgo.isZero()
      ? lastClose.div(weekAgo).sub(D("1"))
      : null;
  const price = position?.price ?? chart?.last?.close ?? null;
  const priceCurrency = position?.price_currency ?? currency;
  const fromHigh = asset.quoteFacts.fromHigh;

  // Signals on this instrument (open ones; a decided one stays as "noted").
  const signals =
    screen.status === "ready"
      ? screen.signals.filter((s) => s.instrument === args.gid && OPEN.has(s.status))
      : [];
  const decidedOf = (s: (typeof signals)[number]) => s.decisions.some((d) => !isAcknowledgement(d));
  const risk = signals.some((s) => s.severity === "action" && !decidedOf(s));

  // Chart: the closes, the owner's levels and trades.
  let chartProps: LineChartProps | null = null;
  if (chart !== null && chart.series.length > 1) {
    const series = chart.series;
    const levels: NonNullable<LineChartProps["levels"]> = [];
    for (const alert of asset.priceAlerts)
      levels.push({
        y: alert.level,
        kind: alert.source === "agent" ? "agent" : "alert",
        label: `${alert.source === "agent" ? Asset.agentAlert : Asset.alert} · ${alert.kind === "price_below" ? Asset.below : Asset.above} ${priceText(Decimal.fromFloat(alert.level), currency, locale)}`,
      });
    for (const t of chart.thresholds) {
      const cost = t.basis === "cost";
      // A level from the owner's average cost sits on the public price axis, so its position alone
      // would give that cost away: it is not drawn while amounts are hidden.
      if (cost && env.privacy) continue;
      const word = (THRESHOLD_WORD as Record<string, string | undefined>)[t.kind] ?? Asset.rule;
      levels.push({
        y: t.y.toFloat(),
        kind: "rule",
        muted: true,
        label: Asset.threshold(
          word,
          t.kind === "gain_from_cost" ? "+" : "-",
          Math.round(t.threshold * 100),
          cost,
          cost ? ownPriceText(t.y, currency, env) : priceText(t.y, currency, locale),
        ),
      });
    }
    if (chart.high_52w !== null)
      levels.push({
        y: chart.high_52w.toFloat(),
        kind: "rule",
        muted: true,
        label: `${Asset.high52} · ${priceText(chart.high_52w, currency, locale)}`,
      });
    if (
      !env.privacy &&
      chart.cost !== null &&
      chart.cost.average !== null &&
      chart.valuation_mode === "market"
    )
      levels.push({
        y: chart.cost.average.toFloat(),
        kind: "cost",
        muted: true,
        label: `${Asset.avgCost} · ${ownPriceText(chart.cost.average, chart.cost.currency ?? currency, env)}`,
      });
    const first = series[0];
    const last = series.at(-1);
    const markers = chart.markers
      .filter((m) => first !== undefined && m.date >= first.date)
      .map((m) => {
        const i = series.findIndex((p) => p.date >= m.date);
        return {
          i: i < 0 ? series.length - 1 : i,
          kind: m.type === "sell" ? ("sell" as const) : ("buy" as const),
        };
      });
    const closeText = (i: number) => {
      const point = series[i];
      return point === undefined ? "" : priceText(point.close, currency, locale);
    };
    chartProps = {
      label: S.chart(name),
      valueKind: "share",
      yFormat: false,
      height: 110,
      series: [
        {
          name,
          area: true,
          values: series.map((p) => p.close.toFloat()),
          accessibleSummary:
            first && last
              ? `${S.from} ${dayText(first.date, locale)} ${closeText(0)} ${S.to} ${dayText(last.date, locale)} ${closeText(series.length - 1)}`
              : name,
        },
      ],
      levels,
      markers,
      xLabels: [0, series.length - 1].map((i) => ({
        i,
        text: axisDayText(series[i]?.date ?? today, locale),
      })),
      tooltip: (i) => ({
        title: dayText(series[i]?.date ?? today, locale),
        rows: [{ name: S.close, value: closeText(i) }],
      }),
    };
  }

  // Quantity and average cost.
  const cost = position === null ? null : averageCostOf(position);
  const facts =
    position === null
      ? null
      : {
          quantity: env.privacy ? MASK : S.shares(quantityText(position.quantity, locale)),
          averageCost: cost === null ? null : ownPriceText(cost.value, cost.currency, env),
        };

  // Signals, research notes and decisions.
  const rows: PositionRow[] = [];
  for (const s of signals) {
    const decided = decidedOf(s);
    const fired = momentText(s.firstSeenAt, today, locale);
    const when = fired.today ? S.today : fired.day;
    rows.push({
      kind: "signal",
      key: s.gid,
      title: signalTitle(s, name, instrument.currency, locale),
      sub: s.alert === null ? S.yourRule(when) : S.yourAlert(when),
      tag: decided ? { text: S.noted, tone: "positive" } : { text: S.open, tone: "negative" },
      onPress: decided ? null : () => args.openAlert(s.gid),
    });
  }
  const notes = (("notes" in research ? research.notes : undefined) ?? [])
    .filter((n) => !n.dismissed)
    .sort((a, b) => (b.observed_at ?? "").localeCompare(a.observed_at ?? ""))
    .slice(0, NOTES_SHOWN);
  for (const n of notes) {
    const tone = RELATION_TONES[n.thesis_relation];
    rows.push({
      kind: "note",
      key: n.id,
      title: n.title,
      sub: S.researchNote(dayText(dayOf(n.observed_at ?? n.created_at ?? args.now), locale)),
      tag:
        tone === undefined
          ? { text: S.background, tone: "neutral" }
          : { text: RELATION[n.thesis_relation as keyof typeof RELATION], tone },
      onPress: () => args.openNote(n.id),
    });
  }
  for (const d of detail.decisions
    .filter((entry) => !isAcknowledgement(entry))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))) {
    const action = (ACTION as Record<string, string | undefined>)[d.action] ?? d.action;
    rows.push({
      kind: "decision",
      key: d.id,
      title: d.reason ? S.decisionWithReason(action, d.reason) : action,
      sub: d.created_at === null ? S.decision : dayText(dayOf(d.created_at), locale),
    });
  }

  const thesis = detail.theses[0] ?? null;
  return {
    kind: "ready",
    title: name,
    hero: {
      ticker: instrument.symbol ?? instrument.label,
      risk,
      name,
      place,
      share: position?.weight == null ? null : S.ofPortfolio(ratioText(position.weight, locale)),
      value: position?.value != null && base !== null ? new Money(position.value, base) : null,
      result: position?.unrealized_pct == null ? null : Decimal.fromFloat(position.unrealized_pct),
      week,
      perUnit: price === null ? null : unit(priceText(price, priceCurrency, locale)),
      fromHigh:
        fromHigh === null
          ? null
          : fromHigh > -0.0005
            ? S.atHigh
            : S.underHigh(ratioText(Math.abs(fromHigh), locale, { fractionDigits: 0 })),
    },
    chart: chartProps,
    range: { value: range, onChange: setRange },
    facts,
    thesis:
      thesis === null
        ? null
        : {
            why: thesis.thesis,
            wrongIf: thesis.invalidation,
            sizePlan: thesis.size_plan,
            exitPlan: thesis.exit_plan,
          },
    rows,
  };
}
