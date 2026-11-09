// Screen hook of the merged budget screen (design/desktop/budget/one-screen.html): one period state in the
// route's search (mode + anchor month) drives the surplus hero with its income / spending chart, the spending
// donut and its drill, the subscriptions, the month close's "after the month" and the uncategorized merchants.
// Every query is started before the first read (useWarmQueries), so the screen reveals once.
import { budget, D, type Decimal, type IsoDate } from "@cashu/domain";
import { intlLocale, lang } from "@cashu/i18n";
import { S as H } from "@cashu/i18n/budget/BudgetHome.strings";
import { S as CD } from "@cashu/i18n/budget/CategoriesDrawer.strings";
import { S as E } from "@cashu/i18n/budget/Expenses.strings";
import { S as MC } from "@cashu/i18n/budget/MonthClose.strings";
import { C } from "@cashu/i18n/core/common.strings";
import { setTransactionCategory } from "@cashu/store";
import {
  budgetDesktopQueries,
  budgetScreenCashflow,
  budgetScreenCurrencies,
  budgetScreenSpending,
  setDesktopMerchantCategory,
} from "@cashu/store/budget/queries";
import { useCommand, useQuery } from "@cashu/store-react";
import { useToast, useUiEnv } from "@cashu/ui";
import { monthLabel, monthShort, planState } from "@cashu/ui-logic/budget/logic";
import type { InvestingLink } from "@cashu/ui-logic/budget/types";
import { cur, cur0s, GROUP } from "@cashu/ui-logic/core/format";
import { bananaMoney, hideAmount } from "@cashu/ui-logic/core/incognito";
import { useState } from "react";
import { commandFailure, useDurableCommands } from "../../useDurableCommand.js";
import { useBudgetCurrency } from "../expenses/budgetCurrency.js";
import { MASK, spendingSlices } from "../expenses/expensesModel.js";
import {
  averageSpending,
  averageSurplusBefore,
  chartWindow,
  clampMonth,
  dataRange,
  defaultMonth,
  type FlowMonth,
  groupSize,
  monthIndex,
  monthKey,
  monthOf,
  niceTicks,
  type PeriodGroup,
  type PeriodMode,
  periodGroups,
  periodTotals,
  quarterOf,
  queryPeriod,
  savingsRate,
  yearOf,
} from "./budgetHomeModel.js";
import type {
  AfterMonthState,
  BudgetHomeState,
  DrillState,
  HeroState,
  SliceState,
  UncategorizedState,
} from "./budgetHomeState.js";
import { shortDate, subscriptionsState } from "./subscriptionsModel.js";
import { useCushionForm } from "./useCushionForm.js";
import { useWarmQueries } from "./useWarmQueries.js";

const queries = budgetDesktopQueries();
/** Drill rows shown before "Pokaż wszystkie". */
const DRILL_ROWS = 8;
/** The uncategorized query lists at most this many merchants (store `desktopUncategorized`). */
const UNCATEGORIZED_CAP = 30;

interface BudgetHomeFilters {
  currency?: string | undefined;
  mode?: PeriodMode | undefined;
  /** The anchor month ("2026-10"): the period is its month / quarter / year. */
  month?: string | undefined;
  drill?: string | undefined;
  sort?: "date" | "amount" | undefined;
}

export interface BudgetHomeOptions {
  today: IsoDate;
  filters: BudgetHomeFilters;
  /** The whole next filter object (the route writes it to the search in a transition). */
  onFilters(next: BudgetHomeFilters): void;
}

/** The other currencies whose surplus in the same period the hero links to ("Też w EUR: ..."). */
export interface OtherCurrencies {
  currencies: readonly string[];
  mode: PeriodMode;
  anchor: number;
  today: IsoDate;
  pick(currency: string): void;
}

/** The categories drawer the "Przejrzyj" button opens. */
export interface ReviewDrawer {
  currency: string;
  onClose(): void;
}

const flowMonths = (
  rows: readonly { label: string; income: Decimal; expense: Decimal }[],
): FlowMonth[] =>
  rows.map((r) => ({ i: monthIndex(r.label), income: r.income, expense: r.expense }));

/** A palette chart colour ("palette-3", "muted") as its CSS token. */
const cssColor = (c: string | number) =>
  c === "muted" ? "var(--color-fg-muted)" : `var(--color-${String(c)})`;

/** The axis label of a group: "paź", January with its year ("sty '26"); "Q3" ("Q1 '26"); "2026". */
function axisLabel(mode: PeriodMode, g: PeriodGroup): string {
  const yy = String(yearOf(g.first) % 100).padStart(2, "0");
  if (mode === "month")
    return monthOf(g.first) === 1 ? `${monthShort(1)} '${yy}` : monthShort(monthOf(g.first));
  if (mode === "quarter") return quarterOf(g.first) === 1 ? `Q1 '${yy}` : `Q${quarterOf(g.first)}`;
  return String(yearOf(g.first));
}

/** The period's long name: "paź 2026", "Q4 2026", "2026". */
function longLabel(mode: PeriodMode, i: number): string {
  if (mode === "month") return monthLabel(monthKey(i));
  if (mode === "quarter") return `Q${quarterOf(i)} ${yearOf(i)}`;
  return String(yearOf(i));
}

/** "PLN 6 037,60": the hero's figure with the currency code in front. */
function codeAmount(v: number, currency: string): string {
  const bananas = bananaMoney(v, currency);
  if (bananas !== null) return bananas;
  const n = new Intl.NumberFormat(intlLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...GROUP,
  }).format(v);
  return hideAmount(`${currency} ${n}`);
}

const signed = (v: number, currency: string) => `${v >= 0 ? "+" : ""}${cur0s(v, currency)}`;

/** Compact axis values ("30 tys.", "30K"); bananas in incognito. */
const compact = (v: number, currency: string) =>
  bananaMoney(v, currency) ??
  hideAmount(new Intl.NumberFormat(intlLocale(), { notation: "compact" }).format(v));

export function useBudgetHome({ today, filters: f, onFilters }: BudgetHomeOptions): {
  state: BudgetHomeState;
  drawer: ReviewDrawer | null;
  others: OtherCurrencies;
} {
  const { privacy } = useUiEnv();
  const toast = useToast();
  const warm = useWarmQueries();
  const language = lang();
  const patch = (values: Partial<BudgetHomeFilters>) => onFilters({ ...f, ...values });
  const mode: PeriodMode = f.mode ?? "month";
  const urlMonth = f.month !== undefined && !Number.isNaN(monthIndex(f.month)) ? f.month : null;
  const sort = f.sort ?? "date";
  const todayMonth = monthIndex(today);

  // Wave 1: everything that needs neither the currency nor the default month (and, when the route already
  // names them, the currency-bound reads too).
  warm(budgetScreenCurrencies, { today });
  warm(queries.settings, undefined);
  warm(queries.subscriptions, undefined);
  warm(queries.monthClose, { today, month: urlMonth, lang: language });
  if (f.currency) {
    warm(budgetScreenCashflow, { today, currency: f.currency, period: {} });
    warm(queries.uncategorized, { currency: f.currency });
    if (urlMonth !== null || mode === "all")
      warm(budgetScreenSpending, {
        today,
        currency: f.currency,
        period: queryPeriod(mode, monthIndex(urlMonth ?? today)),
        lang: language,
      });
  }

  const info = useQuery(budgetScreenCurrencies, { today });
  const bc = useBudgetCurrency({
    today,
    requested: f.currency,
    onChange: (currency) => patch({ currency }),
  });
  const currency = bc.currency;
  const others = bc.codes.filter((c) => c !== currency);
  // The asked month (or the profile's default); clamped to the shown currency's data once its cash flow is
  // in. The reads below start with this guess, which is the clamped month unless the currency's data ends
  // (or starts) elsewhere.
  const guess = urlMonth !== null ? monthIndex(urlMonth) : defaultMonth(info.referenceDate, today);
  const readsFor = (month: number) => {
    const period = queryPeriod(mode, month);
    return {
      drill: { category: f.drill ?? "", currency, period, sort, order: "desc" as const },
      spending: { today, currency, period, lang: language },
      // The default month is what the month close opens on by itself (null keeps wave 1's read).
      close: {
        today,
        month: urlMonth === null && month === guess ? null : monthKey(month),
        lang: language,
      },
    };
  };

  // Wave 2: the reads bound to the currency and the period, all at once (every other currency's cash flow
  // for its "Też w ..." link too).
  for (const c of new Set([currency, bc.base, ...others]))
    warm(budgetScreenCashflow, { today, currency: c, period: {} });
  warm(queries.uncategorized, { currency });
  const guessed = readsFor(guess);
  warm(budgetScreenSpending, guessed.spending);
  warm(queries.drill, guessed.drill);

  const flow = useQuery(budgetScreenCashflow, { today, currency, period: {} });
  const baseFlow = useQuery(budgetScreenCashflow, { today, currency: bc.base, period: {} });
  const months = flowMonths(flow.rows);
  const range = dataRange(months);
  const anchor = clampMonth(guess, range);
  const reads = readsFor(anchor);
  warm(budgetScreenSpending, reads.spending);
  warm(queries.drill, reads.drill);
  warm(queries.monthClose, reads.close);
  const spending = useQuery(budgetScreenSpending, reads.spending);
  const drillRows = useQuery(queries.drill, reads.drill);
  const uncategorized = useQuery(queries.uncategorized, { currency });
  const subscriptions = useQuery(queries.subscriptions);
  const loaded = useQuery(queries.monthClose, reads.close);
  const settings = useQuery(queries.settings);

  const [allRowsOf, setAllRowsOf] = useState<string | null>(null);
  const [subsOpen, setSubsOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const cushion = useCushionForm({
    settings,
    base: loaded.close.baseCurrency,
    codes: bc.codes,
    privacy,
  });

  // ---- period -------------------------------------------------------------------------------------
  const firstData = range?.first ?? anchor;
  const lastData = range?.last ?? anchor;
  const chartMode: PeriodMode = mode === "all" ? "year" : mode;
  const groups = periodGroups(months, chartMode, todayMonth);
  const size = groupSize(mode);
  const groupFirst = Math.floor(anchor / size) * size;
  const goTo = (nextMode: PeriodMode, month: number) =>
    patch({ mode: nextMode, month: monthKey(month) });
  const totals = periodTotals(groups, mode, anchor);
  const periodName = mode === "all" ? E.wholePeriod : longLabel(mode, anchor);

  // ---- hero ---------------------------------------------------------------------------------------
  const surplusD = totals.income.sub(totals.expense);
  const income = totals.income.toFloat();
  const expense = totals.expense.toFloat();
  const surplus = surplusD.toFloat();
  const scale = Math.max(income, expense) || 1;
  const rate = savingsRate(income, expense);
  let sub: HeroState["sub"] = null;
  if (mode === "month") {
    if (totals.partial) sub = { delta: null, positive: true, text: H.soFar };
    else {
      const avg = averageSurplusBefore(months, anchor, todayMonth);
      if (avg) {
        const delta = surplusD.sub(avg.average).toFloat();
        sub = {
          delta: signed(delta, currency),
          positive: delta >= 0,
          text: H.vsAverage(avg.months),
        };
      }
    }
  } else if (totals.doneAverage !== null)
    // The monthly average reads the complete months only (the month in progress would pull it down).
    sub = {
      delta: null,
      positive: true,
      text: H.monthsAverage(totals.doneMonths, cur0s(totals.doneAverage.toFloat(), currency)),
    };
  else if (totals.partial) sub = { delta: null, positive: true, text: H.soFar };

  const [winStart, winEnd] = chartWindow(
    groups.length,
    mode === "all" ? null : groups.findIndex((g) => g.first <= anchor && anchor <= g.last),
  );
  const shown = groups.slice(winStart, winEnd);
  const ticks = niceTicks(
    Math.max(0, ...shown.map((g) => Math.max(g.income.toFloat(), g.expense.toFloat()))),
  );
  const chart: HeroState["chart"] = shown.length
    ? {
        label: H.chart,
        top: ticks.top,
        ticks: ticks.values.map((value) => ({ value, label: compact(value, currency) })),
        groups: shown.map((g) => {
          const net = g.income.sub(g.expense).toFloat();
          return {
            key: g.first,
            label: axisLabel(chartMode, g),
            income: g.income.toFloat(),
            expense: g.expense.toFloat(),
            selected: mode !== "all" && g.first <= anchor && anchor <= g.last,
            partial: g.partial,
            tip: {
              title: `${longLabel(chartMode, g.first)}${g.partial ? ` · ${H.soFar}` : ""}`,
              rows: [
                { name: MC.income, value: cur(g.income.toFloat(), currency) },
                { name: H.spent, value: cur(g.expense.toFloat(), currency) },
                { name: MC.surplus, value: signed(net, currency), negative: net < 0 },
              ],
            },
          };
        }),
        select: (first: number) => {
          const g = groups.find((x) => x.first === first);
          if (g) goTo(chartMode, Math.min(g.last, lastData));
        },
      }
    : null;

  const hero: HeroState = {
    label: surplus < 0 ? H.shortfall : MC.surplus,
    value: codeAmount(surplus, currency),
    negative: surplus < 0,
    sub,
    meters: [
      {
        key: "in",
        label: MC.income,
        fill: (income / scale) * 100,
        tone: "positive",
        value: cur(income, currency),
      },
      {
        key: "out",
        label: H.spent,
        fill: (expense / scale) * 100,
        tone: "negative",
        value: cur(expense, currency),
      },
      { key: "kept", label: H.kept, fill: Math.max(0, rate), tone: "muted", value: `${rate}%` },
    ],
    chart,
    legend: { income: MC.income, spent: H.spent },
  };

  // ---- spending -----------------------------------------------------------------------------------
  const donut = spendingSlices(
    spending.rows.map((r) => ({ category: r.category, label: r.label, amount: r.amount })),
    spending.currency,
  );
  const top = Math.max(0, ...donut.slices.map((s) => s.value)) || 1;
  const toSlice = (s: (typeof donut.slices)[number]): SliceState => ({
    key: s.key,
    label: s.label,
    value: s.value,
    amount: s.amount,
    share: s.share,
    shareText: H.ofSpending(s.share),
    color: cssColor(s.color),
    fill: (s.value / top) * 100,
    ...(s.members ? { members: s.members.map(toSlice) } : {}),
  });
  const slices = donut.slices.map(toSlice);

  // ---- drill --------------------------------------------------------------------------------------
  const categories = budget.CATEGORIES.map((c) => ({
    key: c.key,
    label: budget.categoryLabel(c.key, language),
    kind: c.kind,
  }));
  const labelFor = (key: string) => categories.find((c) => c.key === key)?.label ?? key;
  const categoryCommand = useCommand(setTransactionCategory);
  const merchantCommand = useCommand(setDesktopMerchantCategory);
  const durable = useDurableCommands();
  const applyMerchant = async (merchantKey: string, category: string) => {
    const result = await durable.run(`merchant:${merchantKey}`, merchantCommand, {
      merchantKey,
      category,
    });
    if (result.kind === "completed")
      toast(`${labelFor(category)} · ${E.nTransactions(result.value.updated)}`, 9000);
    else toast(commandFailure(result), 9000);
  };
  // A manual change affects only this transaction; the toast offers the merchant's other ones.
  const markCategory = async (txn: string, category: string) => {
    const row = drillRows.find((r) => r.key === txn);
    if (!row) return;
    const result = await durable.run(`category:${txn}`, categoryCommand, { txn, category });
    if (result.kind !== "completed") {
      toast(CD.notSaved(commandFailure(result)), 9000);
      return;
    }
    if (category === "cash_withdrawal" || !row.merchantKey) return;
    const merchantKey = row.merchantKey;
    const name = row.counterparty || row.merchant || merchantKey;
    toast(E.changed(labelFor(category)), 9000, {
      label: privacy ? H.allFromMerchant : E.allFrom(name),
      onClick: () => void applyMerchant(merchantKey, category),
    });
  };
  const drillKey = `${f.drill}|${mode}|${anchor}|${currency}`;
  const showAllRows = allRowsOf === drillKey;
  const sliceOf = (key: string) =>
    slices.find((s) => s.key === key) ??
    slices.flatMap((s) => s.members ?? []).find((s) => s.key === key);
  const drill: DrillState | null = f.drill
    ? {
        key: f.drill,
        label: labelFor(f.drill),
        color: sliceOf(f.drill)?.color ?? cssColor("muted"),
        meta: H.drillMeta(drillRows.length, periodName),
        sort,
        sortItems: [
          [H.newest, "date"],
          [H.largest, "amount"],
        ],
        sortLabel: E.sorting,
        setSort: (next) => patch({ sort: next }),
        close: () => patch({ drill: undefined }),
        closeLabel: C.close,
        rows: (showAllRows ? drillRows : drillRows.slice(0, DRILL_ROWS)).map((r) => ({
          key: r.key,
          date: shortDate(r.date, mode === "all"),
          merchant: privacy ? MASK : r.merchant || "-",
          details: r.details ? (privacy ? MASK : r.details) : null,
          account: privacy ? MASK : r.account || "-",
          amount: cur(r.amount.toFloat(), r.currency),
          negative: r.amount.toFloat() < 0,
          category: r.category ?? "other",
        })),
        more:
          drillRows.length > DRILL_ROWS
            ? {
                label: showAllRows ? H.showFewer : H.showAll(drillRows.length),
                onPress: () => setAllRowsOf(showAllRows ? null : drillKey),
              }
            : null,
        empty: E.noTransactions,
        categoryLabel: E.category,
        options: [
          ...categories
            .filter((c) => c.kind !== "transfer")
            .map((c) => ({ value: c.key, label: c.label })),
          { value: "cash_withdrawal", label: E.cashWithdrawal },
        ],
        busy: categoryCommand.isPending || merchantCommand.isPending,
        markCategory: (txn, category) => void markCategory(txn, category),
      }
    : null;

  // ---- subscriptions ------------------------------------------------------------------------------
  const subsState = subscriptionsState({
    rows: subscriptions,
    today,
    privacy,
    base: bc.base,
    open: subsOpen,
    toggle: () => setSubsOpen((v) => !v),
    spendingOf: (c) =>
      c === currency
        ? averageSpending(months, todayMonth)
        : c === bc.base
          ? averageSpending(flowMonths(baseFlow.rows), todayMonth)
          : null,
  });

  // ---- after the month ----------------------------------------------------------------------------
  const close = loaded.close;
  const main = close.currencies.find((c) => c.currency === currency) ?? null;
  const c = close.cushion;
  const cushionText =
    loaded.settingsUnavailable || !c
      ? MC.off
      : c.target === null
        ? MC.noHistory
        : c.reached
          ? MC.reached(cur(c.balance.toFloat(), c.currency))
          : MC.progress(
              cur(c.balance.toFloat(), c.currency),
              cur(c.target.toFloat(), c.currency),
              cur(c.topUp.toFloat(), c.currency),
            );
  const inv = close.investing;
  const link: InvestingLink | null = inv
    ? {
        enabled: true,
        strategy_state: inv.strategyState,
        planned: inv.planned
          ? {
              amount: inv.planned.amount.toFloat(),
              currency: inv.planned.currency,
              day_of_month: inv.planned.dayOfMonth,
            }
          : null,
        comparison: inv.comparison
          ? {
              currency: inv.comparison.currency,
              has_data: inv.comparison.hasData,
              surplus: inv.comparison.surplus.toFloat(),
              suggested_transfer: inv.comparison.suggestedTransfer.toFloat(),
              difference: inv.comparison.difference.toFloat(),
              status: inv.comparison.status,
            }
          : null,
      }
    : null;
  const plan = planState(link);
  // The plan row: covered / short with its figure; without a usable plan a quiet line says why (a strategy
  // with errors in the warning colour); nothing while investing is off.
  const planRow: AfterMonthState["plan"] = loaded.strategyUnavailable
    ? { label: MC.plan, value: null, note: H.planUnavailable, tone: "muted" }
    : plan.kind === "covered" || plan.kind === "short"
      ? {
          label: MC.plan,
          value: MC.perMonth(cur0s(plan.planned, plan.currency)),
          tone: plan.kind === "covered" ? "positive" : "warning",
          note:
            plan.kind === "covered"
              ? plan.difference > 0
                ? H.covered(cur0s(plan.difference, plan.currency))
                : H.coveredExactly
              : plan.hasData
                ? MC.short(cur0s(-plan.difference, plan.currency))
                : MC.noData(plan.currency),
        }
      : plan.kind === "no_plan"
        ? {
            label: MC.plan,
            value: null,
            note:
              plan.strategy === "missing"
                ? MC.noStrategy
                : plan.strategy === "invalid"
                  ? MC.strategyInvalid
                  : MC.noContributions,
            tone: plan.strategy === "invalid" ? "warning" : "muted",
          }
        : null;
  const topUp = main?.cushionTopUp?.toFloat() ?? 0;
  const afterMonth: AfterMonthState | null =
    mode === "month"
      ? {
          title: H.afterMonth,
          amount: main ? cur0s(main.suggestedTransfer?.toFloat() ?? null, currency) : null,
          sub: main ? (topUp > 0 ? MC.afterCushion(cur0s(topUp, currency)) : H.toInvest) : null,
          empty: main ? null : MC.noTransactions(currency),
          plan: planRow,
          cushion: {
            label: MC.cushion,
            text: cushionText,
            title: c && !loaded.settingsUnavailable ? MC.cushionLevel : undefined,
            button: cushion.open ? C.close : MC.set,
            disabled: privacy || loaded.settingsUnavailable,
            open: cushion.open,
            toggle: cushion.toggle,
          },
          form: cushion.form,
        }
      : null;

  // ---- uncategorized ------------------------------------------------------------------------------
  const uncat: UncategorizedState | null = uncategorized.length
    ? {
        title: H.needsCategory,
        summary: H.uncategorized(
          uncategorized.length,
          uncategorized.length >= UNCATEGORIZED_CAP,
          cur(uncategorized.reduce((a, r) => a.add(r.total), D("0.00")).toFloat(), currency),
          budget.categoryLabel("other", language),
        ),
        rows: uncategorized.slice(0, 3).map((r) => ({
          key: r.merchantKey,
          name: privacy ? MASK : r.sample,
          count: E.nTransactions(r.count),
          total: cur(r.total.toFloat(), r.currency),
        })),
        review: { label: H.review, onPress: () => setReviewOpen(true) },
      }
    : null;

  return {
    others: {
      currencies: others,
      mode,
      anchor,
      today,
      pick: bc.setCurrency,
    },
    state: {
      period: {
        mode,
        setMode: (next) => goTo(next, anchor),
        label: periodName,
        stepHidden: mode === "all",
        prevDisabled: groupFirst <= firstData,
        nextDisabled: groupFirst + size - 1 >= lastData,
        step: (delta) => {
          const first = groupFirst + delta * size;
          goTo(mode, Math.max(first, Math.min(first + size - 1, lastData)));
        },
        inProgress: mode !== "all" && totals.partial,
      },
      currency: { value: currency, codes: bc.codes, set: bc.setCurrency },
      hero,
      spending: {
        title: H.spending,
        total: cur0s(spending.total.toFloat(), spending.currency),
        slices,
        selected: f.drill ?? null,
        select: (key) => patch({ drill: key === f.drill ? undefined : key }),
        label: H.spending,
        empty: slices.length ? null : E.noTransactions,
      },
      drill,
      subscriptions: subsState,
      afterMonth,
      uncategorized: uncat,
    },
    drawer: reviewOpen ? { currency, onClose: () => setReviewOpen(false) } : null,
  };
}
