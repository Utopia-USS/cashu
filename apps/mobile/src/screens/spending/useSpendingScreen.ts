// Spending by category for a month, quarter or year of one currency. The month view reads the
// companion month (spending against the usual, per category too); quarter and year read the plain
// category totals. Navigation stays in the route: it passes the category and month-close actions.
import { D, type Decimal, type IsoDate, Money } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import { useState } from "react";
import { useServices } from "../../services/ServicesProvider";
import { categorySwatch } from "../categories";
import { choosePeriodKind, stepPeriod } from "../controls/periodSelection";
import type {
  PeriodChoice,
  SpendingPeriodKind,
  SpendingRow,
  SpendingViewProps,
} from "../money-contracts";
import { budgetPeriod } from "../screenContext";
import { S } from "./Spending.strings";

/** A row is over its usual amount above this factor. */
const OVER_USUAL = D("1.1");

const monthLabels = new Map<string, Intl.DateTimeFormat>();
function monthLabel(year: number, month: number, locale: string): string {
  let format = monthLabels.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", timeZone: "UTC" });
    monthLabels.set(locale, format);
  }
  return format.format(new Date(Date.UTC(year, month - 1, 15, 12)));
}

const monthKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

function initialPeriod(month: string | null | undefined, today: string): PeriodChoice {
  const label = month && /^\d{4}-\d{2}$/u.test(month) && month <= today.slice(0, 7) ? month : today;
  return { kind: "month", year: Number(label.slice(0, 4)), month: Number(label.slice(5, 7)) };
}

export function useSpendingScreen(args: {
  readonly today: IsoDate;
  /** "YYYY-MM" to open on; default this month. */
  readonly month?: string | null;
  readonly onCategoryPicked: (category: string) => void;
  readonly onMonthClosePressed: (month: string) => void;
}): SpendingViewProps {
  const { locale } = useUiEnv();
  const { moneyQueries } = useServices();
  const today = args.today;
  const lang = locale.toLowerCase().startsWith("pl") ? "pl" : "en";
  const available = useQuery(moneyQueries.budget.currencies, { today });
  const currencies = available.currencies.map((c) => c.currency);
  const [requested, setRequested] = useState<string | null>(null);
  const currency =
    requested !== null && currencies.includes(requested)
      ? requested
      : currencies.includes(available.baseCurrency)
        ? available.baseCurrency
        : (currencies[0] ?? available.baseCurrency);
  const [period, setPeriod] = useState<PeriodChoice>(() => initialPeriod(args.month, today));
  const use = available.currencies.find((c) => c.currency === currency);
  // From the currency's first transaction up to today: the stepper never walks into the future.
  const bounds = { first: use?.first ?? today, last: today };
  const kind: SpendingPeriodKind = period.kind === "all" ? "month" : period.kind;
  const firstMonth =
    period.kind === "month"
      ? monthKey(period.year, period.month)
      : period.kind === "quarter"
        ? monthKey(period.year, (period.quarter - 1) * 3 + 1)
        : period.kind === "year"
          ? monthKey(period.year, 1)
          : today.slice(0, 7);
  const month = useQuery(moneyQueries.companion.month, {
    today,
    currency,
    month: firstMonth,
    lang,
  });
  const spending = useQuery(moneyQueries.budget.spending, {
    today,
    currency,
    period: budgetPeriod(period),
    lang,
  });

  const isMonth = period.kind === "month";
  const categories = isMonth
    ? month.categories.map((c) => ({
        category: c.category,
        label: c.label,
        amount: c.amount,
        usual: c.usual,
      }))
    : spending.rows.map((r) => ({
        category: r.category,
        label: r.label,
        amount: r.amount,
        usual: null,
      }));
  const sum = categories.reduce((total, c) => total.add(c.amount), D("0.00"));
  const total = isMonth ? month.spent : spending.total;
  const percent = (ratio: Decimal, digits: number, signed = false) =>
    formatDecimalValue(ratio, locale, { percent: true, fractionDigits: digits, signed }).text;

  const rows: SpendingRow[] = categories.map((c) => {
    const share = sum.isZero() ? D("0") : c.amount.div(sum);
    const usual = c.usual;
    const vsUsual: SpendingRow["vsUsual"] =
      !isMonth || usual === null || usual.isZero()
        ? null
        : c.amount.gt(usual.mul(OVER_USUAL))
          ? { kind: "over", text: percent(c.amount.sub(usual).div(usual), 0, true) }
          : { kind: "usual" };
    return {
      key: c.category,
      label: c.label,
      amount: new Money(c.amount, currency),
      swatch: categorySwatch(c.category),
      share,
      vsUsual,
    };
  });

  // Against the usual so far this month, or the usual whole month for a past one.
  const usualBase = !isMonth
    ? null
    : month.complete
      ? (month.norm?.expense ?? null)
      : month.normToDate;
  const vsUsual =
    usualBase === null || usualBase.isZero()
      ? null
      : {
          text: percent(month.spent.sub(usualBase).div(usualBase), 1, true),
          over: month.spent.gt(usualBase),
        };

  const previous = stepPeriod(period, bounds, -1);
  const next = stepPeriod(period, bounds, 1);
  const periodLabel =
    period.kind === "month"
      ? monthLabel(period.year, period.month, locale)
      : period.kind === "quarter"
        ? S.quarterValue(period.quarter, period.year)
        : period.kind === "year"
          ? String(period.year)
          : "";

  return {
    currencies,
    currency,
    onCurrencyChange: setRequested,
    kind,
    onKindChange: (chosenKind) => {
      const chosen = choosePeriodKind(chosenKind, period, bounds);
      if (chosen !== null) setPeriod(chosen);
    },
    periodLabel,
    onPrevious: previous === null ? null : () => setPeriod(previous),
    onNext: next === null ? null : () => setPeriod(next),
    total: new Money(total, currency),
    vsUsual,
    chart: {
      label: S.byCategory,
      center: {
        title: formatDecimalValue(total, locale, { currency, fractionDigits: 0 }).text,
        caption: isMonth && !month.complete ? S.spentSoFar : S.spent,
        amount: true,
      },
      // Ratios become JS numbers only for drawing. Exact amounts stay in rows and the center.
      segments: rows.map((r) => ({
        name: r.label,
        value: Number(r.share.toString()),
        color: r.swatch,
      })),
    },
    rows,
    empty: rows.length === 0,
    otherCurrencies: isMonth
      ? month.otherCurrencies.map((o) => new Money(o.spent, o.currency))
      : [],
    closedMonth:
      isMonth && month.complete ? { month: month.month, label: S.monthClosed(periodLabel) } : null,
    onCategoryPicked: args.onCategoryPicked,
    onMonthClosePressed: args.onMonthClosePressed,
  };
}
