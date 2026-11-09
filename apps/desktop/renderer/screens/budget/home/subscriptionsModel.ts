// The subscriptions tile's model: the monthly total per currency, its year and share of spending, the active
// recurring payments by their next charge and the ended ones. Pure (formatting reads the UI language and the
// incognito flag, like every formatter).
import { budget, D, type Decimal, type IsoDate } from "@cashu/domain";
import { intlLocale } from "@cashu/i18n";
import { S as H } from "@cashu/i18n/budget/BudgetHome.strings";
import { S as SUB } from "@cashu/i18n/budget/Subscriptions.strings";
import type { budgetDesktopQueries } from "@cashu/store/budget/queries";
import { cur, cur0s } from "@cashu/ui-logic/core/format";
import { daysBetween, isMonthly, nextCharge } from "./budgetHomeModel.js";
import type { SubRowState, SubscriptionsState } from "./budgetHomeState.js";

/** Subscriptions listed before "Pokaż wszystkie". */
const NEXT_SUBS = 4;

/** "22 paź" (with the year when the period spans years). */
export function shortDate(iso: string, withYear: boolean): string {
  return new Intl.DateTimeFormat(intlLocale(), {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
}

const percent = (fraction: number) => `${Math.round(fraction * 100)}%`;

export type SubscriptionRow = ReturnType<
  ReturnType<typeof budgetDesktopQueries>["subscriptions"]["run"]
>[number];

/** The subscriptions tile: the monthly total per currency, its year and share of spending, the active rows by
 * their next charge and the ended ones. */
export function subscriptionsState(args: {
  rows: readonly SubscriptionRow[];
  today: IsoDate;
  /** The profile's base currency: the primary total when it has subscriptions. */
  base: string;
  open: boolean;
  toggle(): void;
  /** The average monthly spending of a currency (null when unknown). */
  spendingOf(currency: string): Decimal | null;
}): SubscriptionsState {
  const { today } = args;
  const active = args.rows
    .filter((r) => r.active)
    .map((r) => ({ r, next: nextCharge(r.lastDate, r.medianGapDays) }))
    .sort((a, b) => (a.next < b.next ? -1 : a.next > b.next ? 1 : 0));
  const ended = args.rows
    .filter((r) => !r.active)
    .sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0));
  // The Overview's definition (domain subscriptionsSummary): the typical amounts of the active ones per
  // currency, as they are (detection admits only about monthly gaps), summed exactly.
  const totals = new Map(
    Object.entries(budget.subscriptionsSummary(active.map(({ r }) => r)).monthlyTotals),
  );
  const primary = totals.has(args.base)
    ? args.base
    : ([...totals.entries()].sort((a, b) => b[1].compare(a[1]))[0]?.[0] ?? null);
  const monthly = primary !== null ? (totals.get(primary) ?? null) : null;
  const spent = primary !== null ? args.spendingOf(primary) : null;
  const payee = (r: SubscriptionRow) => r.counterparty;
  const initial = (r: SubscriptionRow) => (r.counterparty.trim()[0] ?? "?").toUpperCase();
  const key = (r: SubscriptionRow) =>
    `${r.counterparty}:${r.currency}:${r.typicalAmount.toString()}`;
  const cadence = (gap: number) =>
    isMonthly(gap) ? H.monthly : gap <= 1 ? H.daily : H.everyDays(gap);
  const activeRow = ({ r, next }: (typeof active)[number]): SubRowState => {
    const days = daysBetween(today, next);
    return {
      key: key(r),
      initial: initial(r),
      payee: payee(r),
      cadence: cadence(r.medianGapDays),
      amount: cur(r.typicalAmount.toFloat(), r.currency),
      when: days < 0 ? H.overdue : days === 0 ? H.today : days === 1 ? H.tomorrow : H.inDays(days),
      soon: days <= 7,
    };
  };
  const endedRow = (r: SubscriptionRow): SubRowState => ({
    key: key(r),
    initial: initial(r),
    payee: payee(r),
    cadence: H.lastOn(shortDate(r.lastDate, r.lastDate.slice(0, 4) !== today.slice(0, 4))),
    amount: cur(r.typicalAmount.toFloat(), r.currency),
    when: null,
    soon: false,
  });
  const hidden = Math.max(0, active.length - NEXT_SUBS) + ended.length;
  return {
    title: SUB.title,
    count: active.length ? H.activeCount(active.length) : null,
    monthly:
      primary !== null && monthly !== null
        ? { value: cur(monthly.toFloat(), primary), unit: H.perMonth }
        : null,
    extra: [...totals.entries()]
      .filter(([c]) => c !== primary)
      .map(([c, v]) => `${cur(v.toFloat(), c)} ${H.perMonth}`),
    sub:
      primary !== null && monthly !== null
        ? [
            H.perYear(cur0s(monthly.mul(D("12")).toFloat(), primary)),
            spent && !spent.isZero() ? H.ofSpending(percent(monthly.div(spent).toFloat())) : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : null,
    nextLabel: H.nextCharges,
    next: active.slice(0, NEXT_SUBS).map(activeRow),
    rest: active.slice(NEXT_SUBS).map(activeRow),
    endedLabel: H.ended,
    ended: ended.map(endedRow),
    open: args.open,
    toggle: hidden
      ? {
          label: args.open ? H.showFewer : H.showAllSubs(active.length, ended.length),
          onPress: args.toggle,
        }
      : null,
    empty: args.rows.length ? null : SUB.none,
  };
}
