// The Today tab: the running month in the profile's base currency (what it is on track to keep, its
// pace against a usual month, income, spending and the bills still due), the ranked "Worth a look"
// rows, the next 7 days, where the money went and the stale-data or consent banner. In the first days
// of a month (`showsClosed`) the closed month takes Today's place until the user asks for the running
// month, which this device remembers for that closed month (`monthClosedSeen`). Navigation stays in the
// route: it passes the callbacks.
import { D, daysBetween, type IsoDate, Money } from "@cashu/domain";
import { dataFreshness } from "@cashu/store/budget/freshness";
import { profileIdentity } from "@cashu/store/core/profile";
import { monthClosedSeen, setMonthClosedSeen } from "@cashu/store/device";
import { useCommand, useProfile, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import { useServices } from "../../services/ServicesProvider";
import { useTabChrome } from "../../shell/useTabChrome";
import { categorySwatch } from "../categories";
import { lastClosedMonth, useMonthClosedScreen } from "../monthClosed/useMonthClosedScreen";
import { localToday } from "../screenContext";
import { type DisplayEnv, dayMonth, moneyText, monthName } from "./display";
import { S, type When } from "./Today.strings";
import type { TodayReady, TodayState } from "./today-contracts";
import { attentionRowOf, showsClosed } from "./todayRules";

/** "Where it went" shows this many categories; the rest fold into one row. */
const TOP_CATEGORIES = 4;
/** Within this many days the "as of" names the weekday, beyond it the date. */
const WEEKDAY_DAYS = 6;

/** When the bank data is from: its weekday within the week, else its date. */
function asOfWhen(bankDataAt: string, now: string, locale: string): When {
  const at = new Date(bankDataAt);
  const day = localToday(at);
  return daysBetween(day, localToday(new Date(now))) <= WEEKDAY_DAYS
    ? at.getDay()
    : dayMonth(day, locale);
}

/** What Today's uncategorized line counts: one month of one currency. */
export interface TriageScope {
  /** "YYYY-MM". */
  readonly month: string;
  readonly currency: string;
}

export function useTodayScreen(args: {
  readonly today: IsoDate;
  /** The current moment (ISO): the age of the bank data is measured to it. */
  readonly now: string;
  /** The categorize deck, scoped to the month and currency the quiet line and the row count. */
  readonly openTriage: (scope: TriageScope) => void;
  readonly openSpending: (month: string) => void;
  readonly openProfile: () => void;
  readonly openClosed: (month: string) => void;
  /** The alert sheet of a position row's open signal. */
  readonly openAlert?: (signal: string) => void;
  /** The position page of a position row without an open alert. */
  readonly openPosition?: (instrument: string) => void;
}): TodayState {
  const ui = useUiEnv();
  const env: DisplayEnv = { locale: ui.locale, privacy: ui.privacy, bananas: ui.bananas ?? null };
  const lang = ui.locale.toLowerCase().startsWith("pl") ? "pl" : "en";
  const { moneyQueries } = useServices();
  const header = useTabChrome({ fresh: "bank", openProfile: args.openProfile });
  const identity = useQuery(profileIdentity);
  const freshness = useQuery(dataFreshness);
  const base = identity?.baseCurrency ?? "";
  const month = useQuery(moneyQueries.companion.month, { today: args.today, currency: base, lang });
  const upcoming = useQuery(moneyQueries.companion.upcoming, { today: args.today });
  const attention = useQuery(moneyQueries.companion.attention, {
    today: args.today,
    currency: base,
    now: args.now,
  });
  const vault = useProfile();
  const putAway = useQuery(monthClosedSeen, { vault });
  const putAwayCommand = useCommand(setMonthClosedSeen);
  const closedMonth = lastClosedMonth(args.today);
  const closed = useMonthClosedScreen({
    today: args.today,
    month: closedMonth,
    chrome: "tab",
    openProfile: args.openProfile,
    onShowRunning: () => void putAwayCommand.run({ vault, month: closedMonth }),
  });
  if (showsClosed(args.today, closed.complete, closed.planSaved, putAway)) {
    return { kind: "closed", month: closedMonth, ...closed.view };
  }

  const currency = month.currency;
  const { projection } = month;
  const money = (value: Parameters<typeof moneyText>[0]) =>
    moneyText(value, currency, env, { fractionDigits: 0 });
  const stale = attention.banner?.kind === "stale";
  const when =
    stale && freshness.bankDataAt !== null
      ? asOfWhen(freshness.bankDataAt, args.now, ui.locale)
      : null;

  const subLine = [
    S.byMonthEnd(dayMonth(month.monthEnd, ui.locale)),
    ...(projection.incomeStillExpected.gt(D("0")) && month.usualPayDay !== null
      ? [S.inclUsualPay(month.usualPayDay)]
      : []),
    ...(when === null ? [] : [S.asOf(when)]),
  ].join(" · ");

  const vsUsual = projection.vsUsual;
  const over = vsUsual?.gt(D("0")) ?? false;
  const pace: TodayReady["hero"]["pace"] =
    projection.pace === null
      ? null
      : {
          spentShare: projection.pace.spentShare,
          usualShare: projection.pace.usualShare,
          left: S.spendingVsUsual,
          right:
            when !== null
              ? S.paceAsOf(when)
              : vsUsual === null
                ? ""
                : over
                  ? S.overUsual(money(vsUsual))
                  : S.underUsual(money(vsUsual.abs())),
          rightTone: when === null && vsUsual !== null && !over ? "positive" : "default",
        };

  const banner: TodayReady["banner"] =
    attention.banner === null
      ? null
      : attention.banner.kind === "stale"
        ? { tone: "warning", title: S.staleTitle(attention.banner.ageHours), body: S.staleBody }
        : {
            tone: "warning",
            title: S.consentTitle(attention.banner.bank, attention.banner.daysLeft),
            body: S.consentBody,
          };

  const total = upcoming.totals[currency];
  const top = month.categories.slice(0, TOP_CATEGORIES);
  const rest = month.categories.slice(TOP_CATEGORIES);
  const largest = top[0]?.amount ?? null;
  const tierOneUncategorized = attention.rows.some((r) => r.reason.kind === "uncategorized_sum");
  const others = month.otherCurrencies.map((o) => o.currency);
  const openMonth = () => args.openSpending(month.month);
  const openTriage = () => args.openTriage({ month: month.month, currency });

  return {
    kind: "ready",
    header,
    title: monthName(month.month, ui.locale).title,
    banner,
    stale,
    hero: {
      label: S.onTrackToKeep,
      daysLeftLabel: S.daysToGo(month.daysLeft),
      keep: new Money(projection.keep, currency),
      negative: projection.keep.lt(D("0")),
      subLine,
      pace,
      kpis: [
        { label: S.income, value: new Money(month.income, currency) },
        { label: S.spent, value: new Money(month.spent, currency) },
        { label: S.billsStillDue, value: new Money(month.billsDue, currency) },
      ],
    },
    attention: attention.rows.map((item) =>
      attentionRowOf(
        item,
        currency,
        env,
        {
          openTriage,
          ...(args.openAlert === undefined ? {} : { openAlert: args.openAlert }),
          ...(args.openPosition === undefined ? {} : { openPosition: args.openPosition }),
        },
        attention.positions,
      ),
    ),
    upcoming: upcoming.rows.map((row) => ({
      key: row.key,
      date: row.when,
      payee: row.payee === "" && row.kind === "planned" ? S.plannedDeposit : row.payee,
      amount: new Money(row.amount, row.currency),
      account: row.account?.name ?? null,
      covered: row.covered,
    })),
    total: total === undefined ? null : new Money(total, currency),
    spent: {
      rows: top.map((c) => ({
        category: c.category,
        label: c.label,
        amount: new Money(c.amount, currency),
        share: largest === null || largest.isZero() ? 0 : c.amount.div(largest).toFloat(),
        swatch: categorySwatch(c.category),
      })),
      more:
        rest.length === 0
          ? null
          : {
              count: rest.length,
              amount: new Money(
                rest.reduce((sum, c) => sum.add(c.amount), D("0.00")),
                currency,
              ),
            },
    },
    uncategorized:
      month.uncategorized.count === 0 || tierOneUncategorized
        ? null
        : {
            count: month.uncategorized.count,
            sum: new Money(month.uncategorized.sum, currency),
          },
    note:
      others.length === 0
        ? S.bankNote
        : `${S.bankNote} ${S.showingBase(currency, others.join(", "))}`,
    onHeroPressed: openMonth,
    onSpentPressed: openMonth,
    onUncategorizedPressed: openTriage,
  };
}
