// The Activity tab: the vault's payments by booking day (newest first, a filter, an account or a
// category from Spending narrowing them), and a search over the whole history that answers first with
// the payee's year-by-year summary. Filter, category and query live in the route params: the hook
// derives everything from them and never keeps a copy. Navigation stays in the route.
import { budget, core, D, type Decimal, type IsoDate, Money } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import {
  budgetUncategorizedCount,
  type CompanionCategoryOption,
  type CompanionTxnRow,
} from "@cashu/store/budget/companion";
import { enabledModules } from "@cashu/store/core/profile";
import { useQuery } from "@cashu/store-react";
import { type SwatchColor, useUiEnv } from "@cashu/ui/native";
import { useDeferredValue, useState, useTransition } from "react";
import { useServices } from "../../services/ServicesProvider";
import type { TabHeaderProps } from "../../shell/TabHeader";
import { useTabChrome } from "../../shell/useTabChrome";
import { categorySwatch } from "../categories";
import { S } from "./Activity.strings";

type ActivityFilter = "all" | "uncategorized" | "income" | "cash";

/** The route params Activity reads and writes; `undefined` removes one. */
export type ActivityParams = {
  filter?: string | undefined;
  category?: string | undefined;
  q?: string | undefined;
};

export type ActivityRow = {
  gid: string;
  payee: string;
  amount: Money;
  income: boolean;
  sub:
    | { kind: "uncategorized" }
    | { kind: "internal" }
    | { kind: "category"; label: string; swatch: SwatchColor; account: string }
    /** A row without a category that needs none (an inflow): the account alone. */
    | { kind: "account"; account: string };
  cash: boolean;
  dim: boolean;
};

export type ActivityDay = {
  date: IsoDate;
  label: string;
  /** Browse only: the day's spending (negative, non-internal rows); null without any. */
  spent: Money | null;
  rows: ActivityRow[];
};

type ActivitySummary = {
  payee: string;
  countLabel: string;
  rows: {
    key: string;
    year: string;
    dateLabel: string;
    amount: Money;
    vsPrevious: string | null;
  }[];
};

export type ActivityState = {
  header: Omit<TabHeaderProps, "title" | "right">;
  /** The budget module is on: the "Cash" button shows (the first expense creates the wallet). */
  canAddCash: boolean;
  /** The vault has a cash wallet: the "Cash" chip shows. */
  showCash: boolean;
  onCashPressed(): void;
  search: { value: string; onChange(value: string): void; onClear(): void };
  filter: ActivityFilter;
  chips: { key: ActivityFilter; label: string; count?: number; active: boolean }[];
  onFilterPicked(key: ActivityFilter): void;
  account: {
    options: { gid: string; name: string }[];
    selected: string | null;
    onPicked(gid: string | null): void;
  };
  /** From `?category=` (a Spending row): a removable tag above the list. */
  categoryFilter: { key: string; label: string; onClear(): void } | null;
  mode: "browse" | "search";
  /** Browse: the list by booking day; search: the hits by day (the full date in the header). */
  days: ActivityDay[];
  /** Search mode: the payee summary (every hit one merchant) and the hit count. */
  results: { summary: ActivitySummary | null; countLabel: string } | null;
  onEndReached(): void;
  isLoadingMore: boolean;
  /** The line that ends a browse list cut at the longest page ("Search to find older payments"). */
  footer: string | null;
  onRowPressed(gid: string): void;
  empty: string | null;
};

const FILTERS: readonly ActivityFilter[] = ["all", "uncategorized", "income", "cash"];
const PAGE = 100;
/** The longest list `budgetTransactions` returns. */
const PAGE_MAX = 300;
/** Shorter queries browse; from this length the field searches. */
const MIN_QUERY = 2;
const BUDGET_TYPES: ReadonlySet<string> = new Set(
  core.BUDGET_MODULE.accountTypes.map((type) => type.id),
);

const formats = new Map<string, Intl.DateTimeFormat>();
function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, options]);
  let format = formats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    formats.set(key, format);
  }
  return format;
}
const noon = (date: IsoDate) => new Date(`${date}T12:00:00Z`);

/** A day header: "Wed, Nov 11" / "śr., 11 lis", with the year outside the current one. */
function dayLabel(date: IsoDate, locale: string, thisYear: string): string {
  return dateFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(date.slice(0, 4) === thisYear ? {} : { year: "numeric" }),
  }).format(noon(date));
}

/** "Mar 14" / "14 mar". */
function dayMonth(date: IsoDate, locale: string): string {
  return dateFormat(locale, { day: "numeric", month: "short" }).format(noon(date));
}

function rowOf(
  row: CompanionTxnRow,
  categories: ReadonlyMap<string, CompanionCategoryOption>,
  lang: core.UiLang,
) {
  const income = row.amount.gt(D("0")) && !row.internal;
  const option = row.category === null ? undefined : categories.get(row.category);
  const sub: ActivityRow["sub"] = row.uncategorized
    ? { kind: "uncategorized" }
    : row.internal
      ? { kind: "internal" }
      : row.category === null
        ? { kind: "account", account: row.account.name }
        : {
            kind: "category",
            label: option?.label ?? budget.categoryLabel(row.category, lang),
            swatch: categorySwatch(row.category),
            account: row.account.name,
          };
  return {
    gid: row.gid,
    payee: row.payee,
    amount: new Money(row.amount, row.currency),
    income,
    sub,
    cash: row.cash,
    dim: row.internal,
  } satisfies ActivityRow;
}

/** The day's spending: one currency's own sum, the base currency's when the day mixes currencies. */
function daySpent(rows: readonly CompanionTxnRow[], base: string): Money | null {
  const sums = new Map<string, Decimal>();
  for (const row of rows) {
    if (!row.amount.lt(D("0")) || row.internal) continue;
    sums.set(row.currency, (sums.get(row.currency) ?? D("0.00")).add(row.amount.neg()));
  }
  const [only] = sums;
  if (sums.size === 1 && only !== undefined) return new Money(only[1], only[0]);
  const own = sums.get(base);
  return own === undefined ? null : new Money(own, base);
}

function groupDays(
  rows: readonly CompanionTxnRow[],
  args: {
    categories: ReadonlyMap<string, CompanionCategoryOption>;
    lang: core.UiLang;
    locale: string;
    today: IsoDate;
    /** Null leaves the day total out (search). */
    base: string | null;
  },
): ActivityDay[] {
  const days: { date: IsoDate; rows: CompanionTxnRow[] }[] = [];
  for (const row of rows) {
    const last = days.at(-1);
    if (last !== undefined && last.date === row.date) last.rows.push(row);
    else days.push({ date: row.date, rows: [row] });
  }
  const thisYear = args.today.slice(0, 4);
  return days.map((day) => ({
    date: day.date,
    label: dayLabel(day.date, args.locale, thisYear),
    spent: args.base === null ? null : daySpent(day.rows, args.base),
    rows: day.rows.map((row) => rowOf(row, args.categories, args.lang)),
  }));
}

export function useActivityScreen(args: {
  params: ActivityParams;
  today: IsoDate;
  openPayment(gid: string): void;
  openCash(): void;
  openProfile(): void;
  setParams(next: ActivityParams): void;
}): ActivityState {
  const { locale } = useUiEnv();
  const { moneyQueries } = useServices();
  const header = useTabChrome({ fresh: "bank", openProfile: args.openProfile });
  const today = args.today;
  const lang: core.UiLang = locale.toLowerCase().startsWith("pl") ? "pl" : "en";
  const [, startFilter] = useTransition();
  const [isLoadingMore, startMore] = useTransition();
  const [limit, setLimit] = useState(PAGE);
  const [pickedAccount, setPickedAccount] = useState<string | null>(null);

  const accounts = useQuery(moneyQueries.holdings.accounts, { today }).filter((a) =>
    BUDGET_TYPES.has(a.type),
  );
  const modules = useQuery(enabledModules);
  const showCash = accounts.some((a) => a.type === budget.CASH_ACCOUNT_TYPE);
  const requested = FILTERS.find((f) => f === args.params.filter) ?? "all";
  const filter: ActivityFilter = requested === "cash" && !showCash ? "all" : requested;
  const account = accounts.some((a) => a.gid === pickedAccount) ? pickedAccount : null;
  const category = args.params.category || null;
  const q = args.params.q ?? "";
  const query = useDeferredValue(q.trim());
  const searching = query.length >= MIN_QUERY;

  const { baseCurrency } = useQuery(moneyQueries.budget.currencies, { today });
  const options = useQuery(moneyQueries.activity.categories, { lang, today });
  const categories = new Map(options.map((o) => [o.key, o]));
  const list = useQuery(moneyQueries.activity.transactions, {
    filter: account === null ? filter : "account",
    account,
    category,
    limit,
  });
  const uncategorizedCount = useQuery(budgetUncategorizedCount, {});
  const found = useQuery(moneyQueries.activity.search, { q: searching ? query : "", lang });

  const days = searching
    ? groupDays(found.rows, { categories, lang, locale, today, base: null })
    : groupDays(list.rows, { categories, lang, locale, today, base: baseCurrency });
  const summary = found.summary;
  const percent = (pct: number) =>
    formatDecimalValue(D(pct.toFixed(6)).div(D("100")), locale, {
      percent: true,
      fractionDigits: 1,
      signed: true,
    }).text;

  const pickFilter = (key: ActivityFilter) =>
    startFilter(() => {
      setPickedAccount(null);
      setLimit(PAGE);
      args.setParams({ filter: key === "all" ? undefined : key });
    });

  return {
    header,
    canAddCash: modules.includes("budget"),
    showCash,
    onCashPressed: args.openCash,
    search: {
      value: q,
      onChange: (value) => args.setParams({ q: value === "" ? undefined : value }),
      onClear: () => args.setParams({ q: undefined }),
    },
    filter,
    chips: [
      { key: "all", label: S.all, active: account === null && filter === "all" },
      {
        key: "uncategorized",
        label: S.toCategorize,
        ...(uncategorizedCount > 0 ? { count: uncategorizedCount } : {}),
        active: account === null && filter === "uncategorized",
      },
      { key: "income", label: S.income, active: account === null && filter === "income" },
      ...(showCash
        ? [{ key: "cash" as const, label: S.cash, active: account === null && filter === "cash" }]
        : []),
    ],
    onFilterPicked: pickFilter,
    account: {
      options: accounts.map((a) => ({ gid: a.gid, name: a.name })),
      selected: account,
      onPicked: (gid) =>
        startFilter(() => {
          setPickedAccount(gid);
          setLimit(PAGE);
        }),
    },
    categoryFilter:
      category === null
        ? null
        : {
            key: category,
            label: categories.get(category)?.label ?? budget.categoryLabel(category, lang),
            onClear: () => startFilter(() => args.setParams({ category: undefined })),
          },
    mode: searching ? "search" : "browse",
    days,
    results: searching
      ? {
          summary:
            summary === null
              ? null
              : {
                  payee: summary.payee,
                  countLabel: S.paymentsSince(summary.count, summary.since),
                  rows: summary.rows.map((r) => ({
                    key: r.key,
                    year: String(r.year),
                    dateLabel: dayMonth(r.date, locale),
                    amount: new Money(r.amount, summary.currency),
                    vsPrevious:
                      r.vsPreviousPct === null ? null : S.vsYearBefore(percent(r.vsPreviousPct)),
                  })),
                },
          countLabel: S.nPayments(found.total),
        }
      : null,
    onEndReached: () => {
      if (searching || list.next === null || limit >= PAGE_MAX) return;
      startMore(() => setLimit(Math.min(PAGE_MAX, limit + PAGE)));
    },
    isLoadingMore,
    footer: !searching && list.next !== null && limit >= PAGE_MAX ? S.useSearch : null,
    onRowPressed: args.openPayment,
    empty: searching
      ? found.total === 0
        ? S.noMatch(query)
        : null
      : list.rows.length === 0
        ? S.nothingHere
        : null,
  };
}
