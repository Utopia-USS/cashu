// The Investments tab's Signals view: since the last review, the alerts that fired (waiting for a
// decision or the decision taken), the price alerts close to their level (public prices, shown in
// incognito too), the open signals of the strategy's rules, the research of the last two weeks with its
// relation to the thesis, and the last decisions. Alerts and rules run on the Mac; the phone reads them.
import { addDays, Decimal, type IsoDate } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { useQuery } from "@cashu/store-react";
import { type TagTone, useUiEnv } from "@cashu/ui/native";
import { useServices } from "../../../services/ServicesProvider";
import { useNow } from "../../../shell/useNow";
import { localToday } from "../../screenContext";
import { dayMonth, instantOf, uiLang, weekdayDayMonth, whenLabel } from "../format";
import type { ReadySignalsProps, SignalsViewProps } from "../investments-contracts";
import { type ReadySignals, useInvestmentSignals } from "../useInvestmentSignals";
import { S } from "./Signals.strings";

type SignalRow = ReadySignals["signals"][number];
type Notes = ReturnType<
  ReturnType<typeof useServices>["moneyQueries"]["investments"]["research"]["notes"]["run"]
>;
type Note = Extract<Notes, { status: "current" }>["notes"][number];

/** Research older than this is not news any more. */
const RESEARCH_DAYS = 14;
const RESEARCH_KINDS = new Set(["news", "earnings", "macro", "trend"]);
const RECENT_DECISIONS = 5;
const OPEN = new Set(["active", "acknowledged"]);

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function pctText(ratio: number, locale: string): string {
  return formatDecimalValue(Decimal.fromFloat(Math.abs(ratio)), locale, { percent: true }).text;
}

function polarityLabel(polarity: string): string {
  return polarity === "negative" ? S.risk : polarity === "positive" ? S.opportunity : S.signal;
}

function actionLabel(action: string): string {
  switch (action) {
    case "bought":
      return S.action_bought;
    case "sold":
      return S.action_sold;
    case "held":
      return S.action_held;
    case "ignored":
      return S.action_ignored;
    default:
      return S.action_other;
  }
}

function relation(note: Note): { tag: string; tone: TagTone } {
  switch (note.thesis_relation) {
    case "weakens":
      return { tag: S.weakens, tone: "negative" };
    case "invalidates":
      return { tag: S.invalidates, tone: "negative" };
    case "supports":
    case "fulfills":
      return { tag: S.supports, tone: "positive" };
    default:
      return { tag: S.background, tone: "neutral" };
  }
}

function signalsProps(
  signals: ReadySignals,
  notes: Notes,
  input: {
    readonly today: IsoDate;
    readonly now: Date;
    readonly locale: string;
    readonly onAlertPressed: (gid: string) => void;
    readonly onNotePressed: (gid: string) => void;
  },
): ReadySignalsProps {
  const { locale, now, today } = input;
  const names = new Map<string, string>(
    signals.instruments.map((i) => [i.id, i.name || i.symbol || i.id]),
  );
  const nameOf = (gid: string | null, fallback: string | null) =>
    (gid === null ? null : names.get(gid)) ?? fallback ?? S.portfolio;

  const lastReview = signals.lastReviewAt === null ? null : instantOf(signals.lastReviewAt);
  const sinceMs = lastReview?.getTime() ?? now.getTime() - 7 * 86_400_000;
  const since =
    lastReview === null
      ? S.sinceLastWeek
      : S.sinceReview(weekdayDayMonth(localToday(lastReview), locale));
  const fresh = (row: SignalRow) => instantOf(row.lastSeenAt).getTime() >= sinceMs;

  // Fired alerts: open ones, and the ones decided since the review.
  const fired = signals.signals
    .filter((s) => s.alert !== null && (OPEN.has(s.status) || (s.decisions.length > 0 && fresh(s))))
    .map((s) => {
      const params = s.messageParams ?? {};
      const change = num(params.change);
      const days = num(params.window_days);
      const name = nameOf(s.instrument, s.instrumentLabel);
      const title =
        s.messageCode === "alert.change_pct" && change !== null && days !== null
          ? (change < 0 || params.direction === "down" ? S.fell : S.rose)(
              name,
              pctText(change, locale),
              days,
            )
          : typeof params.title === "string"
            ? params.title
            : s.message;
      const decision = s.decisions[0];
      if (decision === undefined)
        return {
          gid: s.gid,
          title,
          sub: `${polarityLabel(s.polarity)} · ${whenLabel(instantOf(s.firstSeenAt), now, locale)} · ${S.waitingForDecision}`,
          decided: false,
        };
      return {
        gid: s.gid,
        title: S.noted(name),
        sub:
          decision.action === "held" && decision.reason === "acknowledged"
            ? S.decideLater
            : actionLabel(decision.action),
        decided: true,
      };
    });

  // Live price alerts close to their level, against the public price of the held position.
  const prices = new Map<string, { price: Decimal; currency: string }>();
  if (signals.context.status === "ready")
    for (const p of signals.context.positions.positions)
      if (p.price !== null && p.price_currency !== null)
        prices.set(p.instrument.id, { price: p.price, currency: p.price_currency });
  const near = signals.alerts.flatMap((a) => {
    if (a.status !== "active" || (a.kind !== "price_below" && a.kind !== "price_above")) return [];
    const level = num(a.params.level);
    const quote = a.instrument === null ? undefined : prices.get(a.instrument);
    if (level === null || quote === undefined || quote.price.isZero()) return [];
    const price = quote.price.toFloat();
    const money = (v: Decimal) => formatDecimalValue(v, locale, { currency: quote.currency }).text;
    const levelText = money(Decimal.fromFloat(level));
    return [
      {
        gid: a.gid,
        name: nameOf(a.instrument, a.title),
        price: money(quote.price),
        level: (a.kind === "price_below" ? S.alertBelow : S.alertAbove)(levelText),
        distance: S.away(pctText(Math.abs(price - level) / price, locale)),
      },
    ];
  });

  // The strategy's rules: open signals that are neither alerts nor research.
  const rules = signals.open
    .filter((s) => s.alert === null && s.source !== "research")
    .map((s) => ({
      gid: s.gid,
      message: s.message,
      sub: `${polarityLabel(s.polarity)} · ${whenLabel(instantOf(s.firstSeenAt), now, locale)}`,
      tone:
        s.polarity === "negative"
          ? ("negative" as const)
          : s.polarity === "positive"
            ? ("positive" as const)
            : ("neutral" as const),
    }));

  // Research of the last two weeks, newest first.
  const from = addDays(today, -RESEARCH_DAYS);
  const recent =
    notes.status === "current"
      ? notes.notes
          .filter(
            (n) =>
              !n.dismissed &&
              RESEARCH_KINDS.has(n.kind) &&
              n.observed_at !== null &&
              localToday(instantOf(n.observed_at)) >= from,
          )
          .sort((a, b) => ((a.observed_at ?? "") < (b.observed_at ?? "") ? 1 : -1))
      : [];
  const research = recent.map((n) => {
    const r = relation(n);
    return {
      gid: n.id,
      title: n.title,
      tag: r.tag,
      tone: r.tone,
      sub: `${r.tag} · ${S.nSources(n.sources.length)}`,
    };
  });
  const newest = recent[0];

  const decisions = [...signals.decisions]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, RECENT_DECISIONS)
    .map((d) => ({
      gid: d.gid,
      title: `${nameOf(d.instrument, null)} - ${actionLabel(d.action)}`,
      dateLabel: dayMonth(localToday(instantOf(d.createdAt)), locale),
      reason: d.reason,
    }));

  return {
    status: "ready",
    since,
    fired,
    near,
    rules,
    research,
    researchDay:
      newest?.observed_at == null
        ? null
        : dayMonth(localToday(instantOf(newest.observed_at)), locale),
    decisions,
    onAlertPressed: input.onAlertPressed,
    onNotePressed: input.onNotePressed,
  };
}

export function useSignalsSection(args: {
  readonly openAlert: (signal: string) => void;
  readonly openNote: (note: string) => void;
}): SignalsViewProps {
  const { locale } = useUiEnv();
  const { moneyQueries } = useServices();
  const { today, now } = useNow();
  const signals = useInvestmentSignals();
  const notes = useQuery(moneyQueries.investments.research.notes, { today, lang: uiLang(locale) });
  if (signals.status !== "ready") return { status: "unavailable", message: S.unavailable };
  return signalsProps(signals, notes, {
    today,
    now: new Date(now),
    locale,
    onAlertPressed: args.openAlert,
    onNotePressed: args.openNote,
  });
}
