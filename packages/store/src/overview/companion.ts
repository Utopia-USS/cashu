// The phone companion's cross-module reads of one vault (`@cashu/store/overview/companion`): the
// charges of the coming days (recurring payments, loan installments, planned deposits) against the
// paying accounts' balances, the running month with those bills, the ranked attention list and the
// month close with the synced strategy's plan. Budget figures come from `budget/companion-queries.ts`;
// loans and investments are read here, where modules meet, as `./index.ts` does. Its own entry so the
// phone, whose bundler (Metro) does not tree-shake, carries it without the desktop widgets.
import {
  addDays,
  budget,
  type core,
  D,
  type Decimal,
  daysBetween,
  type IsoDate,
  loans,
  monthEnd,
} from "@cashu/domain";
import { rankAttention } from "@cashu/domain/core/attention";
import { strategyStatus, usableConfig } from "@cashu/domain/investments/strategy";
import { budgetCliCushionEnv, budgetCliSettings } from "../budget/cli-queries.js";
import {
  accountBalances,
  type CompanionMonth,
  type CompanionMonthArgs,
  type CompanionRecurringContext,
  companionMonth,
  companionMonthOf,
  payeeChargeHistories,
  recurringCharges,
} from "../budget/companion-queries.js";
import { dataFreshness } from "../budget/freshness.js";
import { budgetBook } from "../budget/read-models.js";
import { enabledModuleIds } from "../core/queries.js";
import { openPlannedDeposits } from "../investments/queries/planned.js";
import { latestStrategyVersion } from "../investments/queries/strategy.js";
import { mcpLoanRows } from "../loans/mcp-queries.js";
import { loanPayingAccount } from "../loans/screen.js";
import { defineQuery, type Query, type Read } from "../query.js";
import { type OverviewSources, registryOf, vaultPaymentPatterns } from "./networth.js";

// --------------------------------------------------------------------------- upcoming

export type CompanionUpcomingArgs = {
  readonly today: IsoDate;
  /** Default `budget.UPCOMING_HORIZON_DAYS`. */
  readonly horizonDays?: number | null;
};

const HOUR_MS = 3_600_000;

/** The upcoming charges, optionally over recurring charges the caller already has. */
function upcomingOf(
  read: Read,
  args: CompanionUpcomingArgs,
  recurring: readonly budget.RecurringCharge[] | null,
  ctx: CompanionRecurringContext,
): budget.Upcoming {
  const { today } = args;
  const horizonDays = args.horizonDays ?? budget.UPCOMING_HORIZON_DAYS;
  const from = addDays(today, -budget.UPCOMING_GRACE_DAYS);
  const to = addDays(today, horizonDays);
  // Loan installments only with the loans module, planned deposits only with investments.
  const modules = enabledModuleIds(read);
  const loanRows = modules.has("loans") ? mcpLoanRows(read) : [];
  const installments: budget.InstallmentDue[] = loanRows.flatMap(({ loan, account }) => {
    const due = loans
      .schedule(loan.principal, loan.annualRate, loan.termMonths, loan.startDate)
      .filter((row) => row.date >= from && row.date <= to);
    if (due.length === 0) return [];
    const payer = loanPayingAccount(read, loan);
    const paying = payer === null ? null : { id: payer.gid, name: payer.name };
    return due.map((row) => ({
      key: `loan:${loan.id}:${row.n}`,
      loan: loan.id,
      name: account.name,
      date: row.date,
      amount: row.payment,
      currency: account.currency,
      account: paying,
    }));
  });
  const planned: budget.PlannedOutflow[] = (
    modules.has("investments") ? openPlannedDeposits(read) : []
  )
    .filter((p) => p.plannedDate >= from && p.plannedDate <= to)
    .map((p) => ({
      key: `planned:${p.gid}`,
      name: p.note ?? "",
      date: p.plannedDate,
      amount: p.amount,
      currency: p.currency,
      account: null,
    }));
  return budget.upcomingCharges({
    today,
    horizonDays,
    recurring: recurring ?? recurringCharges(read, today, ctx),
    installments,
    planned,
    balances: accountBalances(read, today),
  });
}

/** The recurring-detection context of the overview: its modules' payment patterns and registry. */
const recurringContext = (
  read: Read,
  sources: OverviewSources,
  book?: budget.BudgetBook,
): CompanionRecurringContext => ({
  ...(book === undefined ? {} : { book }),
  patterns: vaultPaymentPatterns(read, sources),
  registry: registryOf(sources),
});

/** The charges of the coming days (`budget.upcomingCharges`) of this vault. */
export function companionUpcoming(
  read: Read,
  args: CompanionUpcomingArgs,
  sources: OverviewSources = {},
): budget.Upcoming {
  return upcomingOf(read, args, null, recurringContext(read, sources));
}

/**
 * The month's known bills: the upcoming rows in `currency` from today to the running month's end, as a
 * positive sum. A past or future month has none (a closed month has nothing left to pay; a coming one
 * is not projected yet).
 */
function billsDue(
  read: Read,
  args: CompanionMonthArgs,
  currency: string,
  ctx: CompanionRecurringContext,
): Decimal {
  const { label } = companionMonthOf(args);
  if (label !== args.today.slice(0, 7)) return D("0.00");
  const start = `${label}-01`;
  const upcoming = upcomingOf(
    read,
    { today: args.today, horizonDays: daysBetween(args.today, monthEnd(args.today)) },
    null,
    ctx,
  );
  let sum = D("0.00");
  // The grace day may reach into the month before on the 1st: only this month's rows count.
  for (const row of upcoming.rows)
    if (row.currency === currency && row.when >= start) sum = sum.add(row.amount.copyAbs());
  return sum;
}

/** `companionMonth` with the bills still due this month and the projection over them. */
export function companionMonthWithBills(
  read: Read,
  args: CompanionMonthArgs,
  sources: OverviewSources = {},
): CompanionMonth {
  const book = budgetBook(read);
  const currency = args.currency || book.baseCurrency;
  const bills = billsDue(read, args, currency, recurringContext(read, sources, book));
  return companionMonth(read, { ...args, currency }, { book, billsDue: bills });
}

// --------------------------------------------------------------------------- attention

export type CompanionAttentionArgs = {
  readonly today: IsoDate;
  readonly currency: string;
  /** The current moment (ISO datetime): the age of the bank data is measured to it. */
  readonly now: string;
};

/** Whole hours from the newest import to `now`; null when either is unknown. */
function ageHours(at: string | null, now: string): number | null {
  if (at === null) return null;
  const ms = Date.parse(now) - Date.parse(at);
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / HOUR_MS)) : null;
}

/** The ranked attention list of the running month in one currency (positions come with M2). */
export function companionAttention(
  read: Read,
  args: CompanionAttentionArgs,
  sources: OverviewSources = {},
): ReturnType<typeof rankAttention> {
  const book = budgetBook(read);
  const currency = args.currency || book.baseCurrency;
  const ctx = recurringContext(read, sources, book);
  const payees = payeeChargeHistories(read, args.today, ctx);
  const upcoming = upcomingOf(read, { today: args.today }, payees, ctx);
  const month = companionMonth(read, { today: args.today, currency, lang: "en" }, { book });
  const usualMonth = month.norm?.expense ?? null;
  const largest = month.uncategorized.largest;
  const freshness = dataFreshness.run(read, undefined);
  return rankAttention({
    today: args.today,
    currency,
    month: { spentSoFar: month.spent, usualMonth },
    uncategorized: {
      count: month.uncategorized.count,
      sum: month.uncategorized.sum,
      largest:
        largest === null
          ? null
          : { payee: largest.payee, date: largest.date, amount: largest.amount },
    },
    bills: upcoming.rows,
    positions: [],
    // Every rise: whether it is worth a look against the usual month is the attention list's call.
    payeeChanges: budget.payeeChanges({ today: args.today, currency, payees }),
    freshness: {
      bankDataAgeHours: ageHours(freshness.bankDataAt, args.now),
      consentEndsInDays: null,
    },
  });
}

// --------------------------------------------------------------------------- month close

export type CompanionMonthCloseArgs = {
  readonly today: IsoDate;
  /** "YYYY-MM"; default `budget.defaultMonth`. */
  readonly month?: string | null;
  readonly lang: core.UiLang;
};

export type CompanionMonthClose = budget.MonthCloseView & {
  /**
   * The open planned deposit of the month after the closed one (where its surplus is invested): the
   * latest-dated one when there are several; null without one or without the investments module.
   */
  readonly plannedDeposit: {
    readonly gid: string;
    readonly amount: Decimal;
    readonly currency: string;
  } | null;
};

/**
 * The synced strategy's planned contribution: the newest stored version loaded as the strategy
 * service loads files; null without a version or for an invalid one.
 */
function strategyPlan(read: Read): budget.PlannedContribution | null {
  const version = latestStrategyVersion(read);
  if (version === undefined) return null;
  const status = strategyStatus(
    { yaml: version.yamlText, md: version.mdText, readError: null },
    null,
  );
  if (status.state === "invalid" || status.state === "missing") return null;
  return budget.plannedContribution(status.state, usableConfig(status));
}

export function companionMonthClose(
  read: Read,
  args: CompanionMonthCloseArgs,
): CompanionMonthClose {
  const parsed = args.month ? budget.parseMonth(args.month) : null;
  if (parsed !== null && !parsed.ok) throw new RangeError("invalid budget month");
  const investmentsEnabled = enabledModuleIds(read).has("investments");
  const close = budget.monthClose(budgetBook(read), {
    today: args.today,
    settings: budgetCliSettings(read) ?? budget.defaultBudgetSettings(),
    env: budgetCliCushionEnv(read),
    investmentsEnabled,
    planned: investmentsEnabled ? strategyPlan(read) : null,
    ...(parsed?.ok ? { year: parsed.year, month: parsed.month } : {}),
  });
  const [year, month] = budget.shiftMonth(close.year, close.month, 1);
  const next = budget.monthLabel(year, month);
  const plan = investmentsEnabled
    ? openPlannedDeposits(read)
        .filter((p) => p.plannedDate.slice(0, 7) === next)
        .at(-1)
    : undefined;
  return {
    ...budget.monthCloseView(close, args.lang),
    plannedDeposit:
      plan === undefined ? null : { gid: plan.gid, amount: plan.amount, currency: plan.currency },
  };
}

// --------------------------------------------------------------------------- queries

export interface CompanionQueries {
  readonly upcoming: Query<CompanionUpcomingArgs, budget.Upcoming>;
  readonly month: Query<CompanionMonthArgs, CompanionMonth>;
  readonly attention: Query<CompanionAttentionArgs, ReturnType<typeof rankAttention>>;
  readonly monthClose: Query<CompanionMonthCloseArgs, CompanionMonthClose>;
}

/**
 * The companion's overview queries. No companion read values prices yet, so none takes the device's
 * price cache (M2 binds it with the positions).
 */
export function companionQueries(sources: OverviewSources = {}): CompanionQueries {
  return {
    upcoming: defineQuery({
      id: "core.companionUpcoming",
      run: (read, args: CompanionUpcomingArgs) => companionUpcoming(read, args, sources),
    }),
    month: defineQuery({
      id: "core.companionMonth",
      run: (read, args: CompanionMonthArgs) => companionMonthWithBills(read, args, sources),
    }),
    attention: defineQuery({
      id: "core.attention",
      run: (read, args: CompanionAttentionArgs) => companionAttention(read, args, sources),
    }),
    monthClose: defineQuery({
      id: "core.companionMonthClose",
      run: (read, args: CompanionMonthCloseArgs) => companionMonthClose(read, args),
    }),
  };
}
