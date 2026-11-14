// The pure rules of the Today tab: when the month-closed state takes Today's place, and how one
// ranked attention item becomes a "Worth a look" row (icon, tone, copy, magnitude, where it leads).
import { D, type Decimal, type IsoDate, parseDate } from "@cashu/domain";
import type { AttentionItem } from "@cashu/domain/core/attention";
import { type DisplayEnv, dayMonth, moneyText, percentText, shiftMonth, shortDay } from "./display";
import { S } from "./Today.strings";
import type { TodayAttentionRow } from "./today-contracts";

/** The month-closed state shows through this day of the month at least. */
const CLOSED_FIRST_DAYS = 3;

/**
 * The month-closed state replaces Today's content while the month before is complete and either the
 * month is in its first `CLOSED_FIRST_DAYS` days or the plan for the running month is not saved yet
 * (whichever keeps it longer), unless the owner put that closed month away on this device ("Show the
 * running month", `putAway` = the month put away last): then it shows again only for a later month.
 */
export function showsClosed(
  today: IsoDate,
  lastClosedComplete: boolean,
  planSaved: boolean,
  putAway: string | null,
): boolean {
  if (!lastClosedComplete) return false;
  if (putAway !== null && putAway >= shiftMonth(today.slice(0, 7), -1)) return false;
  return parseDate(today).day <= CLOSED_FIRST_DAYS || !planSaved;
}

/** What an attention row can lead to. */
export interface AttentionActions {
  openTriage(): void;
  /** The alert sheet of an open signal (a position row with a fired alert). */
  openAlert?(signal: string): void;
  /** The position page (a position row without an open alert). */
  openPosition?(instrument: string): void;
}

/** The attention query's details of a ranked position (`CompanionAttention.positions`). */
export interface AttentionPositionDetail {
  readonly signal: string | null;
  /** The week's move as a share; null when unknown. */
  readonly week: number | null;
}

/** One ranked attention item as a "Worth a look" row; `currency` is the month's (the list's own). */
export function attentionRowOf(
  item: AttentionItem,
  currency: string,
  env: DisplayEnv,
  actions: AttentionActions,
  positions: Readonly<Record<string, AttentionPositionDetail>> = {},
): TodayAttentionRow {
  const key = `${item.subject.kind}:${item.subject.id}`;
  const money = (value: Decimal, options: { signed?: boolean; fractionDigits?: number } = {}) =>
    moneyText(value, currency, env, { fractionDigits: 0, ...options });
  const shareText =
    item.magnitude.kind === "percent"
      ? percentText(D(String(item.magnitude.value)), env.locale)
      : "";
  const reason = item.reason;
  switch (reason.kind) {
    case "uncategorized_sum":
      return {
        key,
        icon: "tag",
        tone: "warn",
        title: S.notCategorized(money(reason.sum)),
        sub:
          reason.largest === null
            ? S.projectionMayBeOff
            : `${S.mostlyAt(reason.largest.payee, shortDay(reason.largest.date, env.locale))} · ${S.projectionMayBeOff}`,
        magnitude: shareText,
        magnitudeLabel: S.ofSpending,
        onPress: actions.openTriage,
      };
    case "bill_uncovered":
      return {
        key,
        icon: "calendar",
        tone: "neg",
        title: S.billNotCovered(reason.payee),
        sub: S.dueFromAccount(dayMonth(reason.when, env.locale), reason.account?.name ?? null),
        magnitude: money(reason.shortfall),
        magnitudeLabel: S.short,
        onPress: null,
      };
    case "position": {
      const detail = positions[reason.instrument.id];
      const move = (share: number) =>
        percentText(D(String(share)), env.locale, { fractionDigits: 1, signed: true });
      const why = [
        reason.alertFired ? S.alertFired : null,
        reason.researchVerdict === "invalidates"
          ? S.researchInvalidates
          : reason.researchVerdict === "weakens"
            ? S.researchWeakens
            : null,
      ].filter((part) => part !== null);
      if (why.length === 0 && reason.dayMove !== null)
        why.push(S.bigMoveToday(move(reason.dayMove)));
      const signal = detail?.signal ?? null;
      const { openAlert, openPosition } = actions;
      return {
        key,
        icon: "bell",
        tone: "neg",
        title: S.positionMoved(
          reason.instrument.name,
          detail?.week == null ? null : move(detail.week),
        ),
        sub: why.join(" · "),
        magnitude: shareText,
        magnitudeLabel: S.ofPortfolio,
        onPress:
          signal !== null && openAlert !== undefined
            ? () => openAlert(signal)
            : openPosition !== undefined
              ? () => openPosition(reason.instrument.id)
              : null,
      };
    }
    case "payee_price_up":
      return {
        key,
        icon: "calendar",
        tone: "default",
        title: S.payeeCostsMore(reason.payee),
        sub: S.fromTo(
          money(reason.from, { fractionDigits: 2 }),
          money(reason.to, { fractionDigits: 2 }),
          dayMonth(reason.nextDate, env.locale),
        ),
        magnitude: money(reason.yearlyEffect, { signed: true }),
        magnitudeLabel: S.aYear,
        onPress: null,
      };
    case "payee_new_recurring":
      return {
        key,
        icon: "calendar",
        tone: "default",
        title: S.newRecurring(reason.payee),
        sub: S.everyNDays(reason.cadenceDays),
        magnitude: money(reason.amount),
        magnitudeLabel: S.perCharge,
        onPress: null,
      };
  }
}
