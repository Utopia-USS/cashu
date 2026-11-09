// The overview read models of one vault (`@cashu/store/overview`), composed from core and every
// module's registered sources (`StoreModule.netWorth` / `.setup`), as Python's composition layer did
// (`api/app.py` `/summary`, `core/api.py` `/networth/series` and `/modules/{id}/setup`,
// `profiles.as_dict` setup states): the net-worth history view, the shell summary, the hero facts and
// each module's blank-page status. Core never imports a module; this folder sits above both, like
// `modules.ts`.
//
// Net worth reads the device's price cache besides the view (brokerage valuation), so the queries are
// built once per process over that cache (`overviewQueries`); their ids stay stable. Heavy work stays
// here (one book per run, in the store process), never in render. The net-worth read models themselves
// live in `./networth.ts` (`@cashu/store/overview/networth`, what the phone imports).
import { budget, core, D, type Decimal, type IsoDate, loans } from "@cashu/domain";
import type { market } from "@cashu/domain/investments";
import * as perf from "@cashu/domain/investments/performance";
import { budgetCliCushionEnv, budgetCliSettings } from "../budget/cli-queries.js";
import { budgetBook, budgetEngineContext } from "../budget/read-models.js";
import { enabledModuleIds, profileOf } from "../core/queries.js";
import { performanceInputs } from "../investments/performance/inputs.js";
import { plannedDeposits } from "../investments/queries/planned.js";
import { monthPlan } from "../investments/services/planned.js";
import { readOverview } from "../investments/views/overview.js";
import { mcpLoanRows } from "../loans/mcp-queries.js";
import { type ChangeSource, defineQuery, type Query, type Read } from "../query.js";
import {
  modulesOf,
  type NetWorthQueries,
  netWorthQueries,
  type OverviewSources,
  registryOf,
  vaultNetWorthBook,
  vaultPaymentPatterns,
} from "./networth.js";
import {
  type OverviewAccount,
  type OverviewAsset,
  overviewAccounts,
  overviewAssets,
} from "./widgets.js";

export {
  HERO_CASHFLOW_MONTHS,
  type HeroView,
  heroView,
  type NetWorthQueries,
  netWorthQueries,
  netWorthSeries,
  type OverviewSources,
  type SeriesArgs,
  type ShellSummary,
  type ShellSummarySnapshot,
  shellSummary,
  vaultNetWorthBook,
  vaultPaymentPatterns,
} from "./networth.js";
export { type CashWalletView, cashWallet, overviewCashWallet } from "./widgets.js";

// --------------------------------------------------------------------------- module setup

export interface ModuleSetupView extends core.SetupView {
  /** The copyable command prefix the steps were rendered with. */
  readonly cliPrefix: string;
  /** The module's Claude Code setup skill command (`/budget-setup`); null when it has none. */
  readonly skill: string | null;
}

/** Expected refusal of a setup read (the API answers 404). */
export type ModuleSetupResult =
  | { readonly ok: true; readonly value: ModuleSetupView }
  | { readonly ok: false; readonly reason: "unknown_module" };

/** `GET /modules/{id}/setup` (`profiles.module_setup`): the module's blank-page status. */
export function moduleSetup(
  read: Read,
  moduleId: string,
  ctx: core.SetupContext,
  sources: OverviewSources = {},
): ModuleSetupResult {
  const spec = registryOf(sources).modules.get(moduleId);
  if (spec === undefined) return { ok: false, reason: "unknown_module" };
  const source = modulesOf(sources).find((m) => m.id === moduleId)?.setup;
  const steps = source === undefined ? [] : source(read, ctx);
  return { ok: true, value: { ...core.setupView(steps), cliPrefix: ctx.cli, skill: spec.skill } };
}

export interface ModuleState {
  readonly id: string;
  readonly enabled: boolean;
  readonly setupState: core.SetupState;
}

/** `profiles.as_dict` modules: every known module (display order), enabled or not, with its state. */
export function moduleStates(read: Read, sources: OverviewSources = {}): ModuleState[] {
  const enabled = enabledModuleIds(read);
  // The state counts done steps only: neither the language nor the command prefix changes it.
  const ctx: core.SetupContext = { cli: "", lang: "pl" };
  return [...registryOf(sources).modules.values()].map((spec) => {
    const result = moduleSetup(read, spec.id, ctx, sources);
    return {
      id: spec.id,
      enabled: enabled.has(spec.id),
      setupState: result.ok ? result.value.state : "empty",
    };
  });
}

// --------------------------------------------------------------------------- queries

export interface OverviewQueries extends NetWorthQueries {
  readonly moduleSetup: Query<
    { readonly module: string; readonly cli: string; readonly lang: core.UiLang },
    ModuleSetupResult
  >;
  readonly moduleStates: Query<undefined, ModuleState[]>;
  readonly accounts: Query<{ readonly today: IsoDate }, OverviewAccount[]>;
  readonly budgetWidgets: Query<{ readonly today: IsoDate }, BudgetWidgets>;
  readonly assets: Query<{ readonly today: IsoDate }, OverviewAsset[]>;
  readonly loans: Query<{ readonly today: IsoDate }, readonly OverviewLoan[]>;
  readonly investments: Query<
    { readonly today: IsoDate; readonly lang: core.UiLang },
    InvestmentWidgets
  >;
}

export type InvestmentWidgets =
  | { readonly status: "unavailable" }
  | {
      readonly status: "available";
      readonly value: Decimal;
      readonly currency: string;
      readonly positive: number;
      readonly risks: number;
      readonly alertsTriggered: number;
      readonly lastRun: { readonly status: string; readonly at: string | null } | null;
      readonly ytd: number | null;
      readonly benchmarkYtd: number | null;
      readonly benchmarkStatus: string;
      readonly yearPoints: readonly { readonly date: IsoDate; readonly value: number }[];
      readonly monthPlan: {
        readonly monthlyAmount: Decimal | null;
        readonly remaining: Decimal | null;
        readonly covered: boolean | null;
        readonly plannedCount: number;
        readonly currency: string;
        readonly dayOfMonth: number | null;
      } | null;
      /**
       * Python `GET /planned-deposits` items (default statuses: open and booked), in creation order:
       * a booked plan carries when an import booked it.
       */
      readonly plans: readonly {
        readonly gid: string;
        readonly amount: Decimal;
        readonly currency: string;
        readonly plannedDate: string;
        readonly status: "planned" | "booked";
        /** When a stored deposit booked the plan (Python books only from an imported deposit). */
        readonly bookedAt: string | null;
      }[];
    };

export function investmentWidgets(
  read: Read,
  context: {
    readonly today: IsoDate;
    readonly lang: core.UiLang;
    readonly prices: market.PriceCache | null;
  },
  sources: OverviewSources,
): InvestmentWidgets {
  const profile = profileOf(read);
  const vault = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
  const request = sources.investmentRequest?.(read, context);
  if (
    profile === undefined ||
    vault === undefined ||
    request === null ||
    request === undefined ||
    request.vault !== vault ||
    request.asOf !== context.today ||
    request.clock.today !== context.today ||
    !request.forOwner
  )
    return { status: "unavailable" };
  const overview = readOverview(read, request);
  if (!overview.ok) return { status: "unavailable" };
  const config = request.strategy.config;
  const performanceStrategy: perf.PerformanceStrategy = {
    state: request.strategy.state,
    benchmark: config?.benchmark ?? null,
    policy:
      config === null
        ? perf.DEFAULT_VALUATION_POLICY
        : { maxPriceAgeDays: config.data.maxPriceAgeDays, maxFxAgeDays: config.data.maxFxAgeDays },
    strategy:
      config === null ? null : { baseCurrency: config.baseCurrency, allocation: config.allocation },
  };
  const computed = perf.computePerformance(
    performanceInputs(read, { ...request, strategy: performanceStrategy }),
    context.today,
  );
  const ytd = perf.performanceView(computed, "ytd");
  const year = perf.performanceView(computed, "1y");
  const kpis = overview.value.kpis;
  const lastRun = kpis.last_run;
  const planned =
    request.prices === undefined
      ? null
      : monthPlan(read, { today: context.today, strategy: config, prices: request.prices });
  const plan = planned?.ok ? planned.value : null;
  return {
    status: "available",
    value: kpis.value.total,
    currency: overview.value.base_currency,
    positive: kpis.polarity.positive,
    risks: kpis.polarity.negative + kpis.polarity.neutral,
    alertsTriggered: kpis.alerts.triggered,
    lastRun:
      lastRun === null
        ? null
        : { status: lastRun.status, at: lastRun.finished_at ?? lastRun.started_at },
    ytd: ytd.summary?.twr ?? null,
    benchmarkYtd: ytd.benchmark.twr,
    benchmarkStatus: ytd.benchmark.status,
    yearPoints: year.points.flatMap((point) =>
      point.value === null ? [] : [{ date: point.date, value: point.value }],
    ),
    monthPlan:
      plan === null
        ? null
        : {
            monthlyAmount: plan.monthlyAmount,
            remaining: plan.remaining,
            covered: plan.covered,
            plannedCount: plan.plannedCount,
            currency: plan.currency,
            dayOfMonth: plan.dayOfMonth,
          },
    plans: plannedDeposits(read, ["planned", "booked"], "created").flatMap((row) =>
      row.status === "cancelled"
        ? []
        : [
            {
              gid: row.gid,
              amount: row.amount,
              currency: row.currency,
              plannedDate: row.plannedDate,
              status: row.status,
              bookedAt: row.bookedAt,
            },
          ],
    ),
  };
}

export interface OverviewLoan {
  readonly gid: string;
  readonly name: string;
  readonly currency: string;
  readonly outstanding: loans.LoanSummaryView["outstanding"];
  readonly monthlyPayment: loans.LoanSummaryView["monthlyPayment"];
  readonly annualRate: loans.LoanSummaryView["annualRate"];
  readonly payoffDate: IsoDate;
  readonly nextPrincipal: loans.LoanSummaryView["outstanding"] | null;
}

export function overviewLoans(read: Read, today: IsoDate): OverviewLoan[] {
  const base = profileOf(read)?.baseCurrency ?? "PLN";
  return mcpLoanRows(read).map(({ loan, account, balances }) => {
    const summary = loans.loanSummary(
      loan,
      { id: account.gid, name: account.name, type: account.type, currency: account.currency },
      loans.loanValuation(loan, balances),
      today,
      base,
    );
    const next = loans
      .schedule(loan.principal, loan.annualRate, loan.termMonths, loan.startDate)
      .find((row) => row.date >= today);
    return {
      gid: loan.id,
      name: account.name,
      currency: account.currency,
      outstanding: summary.outstanding,
      monthlyPayment: summary.monthlyPayment,
      annualRate: summary.annualRate,
      payoffDate: summary.payoffDate,
      nextPrincipal: next?.principal ?? null,
    };
  });
}

export interface BudgetWidgets {
  readonly month: {
    readonly label: string;
    readonly complete: boolean | null;
    readonly income: budget.MonthSummary["income"];
    readonly spending: budget.MonthSummary["expense"];
    readonly surplus: budget.MonthSummary["net"];
    /**
     * Surplus over income; null for a month in progress, a month the data does not cover whole (the
     * first month of an import) or without income.
     */
    readonly savingsRate: Decimal | null;
    readonly suggestedTransfer: Decimal | null;
    readonly currency: string;
    readonly otherCurrencies: readonly string[];
  } | null;
  readonly norm: budget.MonthNorm | null;
  /** Surplus over income of the last 6 whole, closed months (`budget.averageSavingsRate`). */
  readonly averageSavingsRate: budget.MonthSummary["net"] | null;
  readonly subscriptions: budget.SubscriptionsSummary;
  readonly subscriptionCurrency: string;
  readonly subscriptionNorm: budget.MonthNorm | null;
  readonly dueThisWeek: readonly string[];
  readonly staleCount: number;
  readonly strategyUnavailable: boolean;
}

/** Read-only Overview widget facts from one native vault, with no cross-currency summation. */
export function budgetWidgets(
  read: Read,
  today: IsoDate,
  sources: OverviewSources = {},
): BudgetWidgets {
  const book = budgetBook(read);
  const base = book.baseCurrency;
  const registry = registryOf(sources);
  const candidates = budget.recurringPayments(
    book,
    budgetEngineContext(read, vaultPaymentPatterns(read, sources), registry),
    budget.subscriptionExclusions(registry),
  );
  const active = budget.activeRecurring(candidates, book);
  const subscriptions = budget.subscriptionsSummary(active);
  const subscriptionCurrency =
    subscriptions.monthlyTotals[base] !== undefined
      ? base
      : (Object.keys(subscriptions.monthlyTotals)[0] ?? base);
  // Only whole months: the first month of an import begins mid-month and would read as a month
  // with almost no income.
  const rows = budget.monthlyCashflow(book, base);
  const start = budget.cashflowCoverageStart(book, base);
  const norm = budget.closedMonthNorm(budget.wholeMonths(rows, start), today);
  const averageSavingsRate = budget.averageSavingsRate(rows, start, today);
  const subscriptionNorm = budget.closedMonthNorm(
    budget.wholeMonths(
      budget.monthlyCashflow(book, subscriptionCurrency),
      budget.cashflowCoverageStart(book, subscriptionCurrency),
    ),
    today,
  );
  const current = Date.parse(`${today}T12:00:00Z`);
  const dueThisWeek = active
    .filter((candidate) => {
      const next =
        Date.parse(`${candidate.lastDate}T12:00:00Z`) + candidate.medianGapDays * 86_400_000;
      return next >= current - 86_400_000 && next <= current + 7 * 86_400_000;
    })
    .map((candidate) => candidate.counterparty);
  const staleCount = candidates.length - active.length;
  const investmentsEnabled = enabledModuleIds(read).has("investments");
  const strategyUnavailable = investmentsEnabled && sources.plannedContribution === undefined;
  const settings = budgetCliSettings(read);
  const date = new Date(Date.parse(`${today.slice(0, 7)}-01T12:00:00Z`));
  date.setUTCMonth(date.getUTCMonth() - 1);
  const close =
    settings === null || strategyUnavailable
      ? null
      : budget.monthClose(book, {
          year: date.getUTCFullYear(),
          month: date.getUTCMonth() + 1,
          today,
          settings,
          env: budgetCliCushionEnv(read),
          investmentsEnabled,
          planned: sources.plannedContribution?.(read) ?? null,
        });
  const preferred = close?.currencies.find((row) => row.currency === base) ?? close?.currencies[0];
  const fallback = budget.monthSummary(rows);
  /** A month's savings rate: only for a closed month the data covers whole, with income. */
  const savingsRate = (
    label: string,
    complete: boolean | null,
    currency: string,
    income: Decimal,
    surplus: Decimal,
  ): Decimal | null => {
    const from = currency === base ? start : budget.cashflowCoverageStart(book, currency);
    const whole = from === null || `${label}-01` >= from;
    const closed = complete ?? label < today.slice(0, 7);
    return whole && closed && income.gt(D("0")) ? surplus.div(income) : null;
  };
  const month =
    preferred === undefined
      ? fallback === null
        ? null
        : {
            label: fallback.label,
            complete: null,
            income: fallback.income,
            spending: fallback.expense,
            surplus: fallback.net,
            savingsRate: savingsRate(fallback.label, null, base, fallback.income, fallback.net),
            suggestedTransfer: null,
            currency: base,
            otherCurrencies: [],
          }
      : {
          label: close?.label ?? "",
          complete: close?.complete ?? null,
          income: preferred.income,
          spending: preferred.spending,
          surplus: preferred.surplus,
          savingsRate: savingsRate(
            close?.label ?? "",
            close?.complete ?? null,
            preferred.currency,
            preferred.income,
            preferred.surplus,
          ),
          suggestedTransfer: preferred.suggestedTransfer,
          currency: preferred.currency,
          otherCurrencies:
            close?.currencies
              .filter((row) => row.currency !== preferred.currency)
              .map((row) => row.currency) ?? [],
        };
  return {
    month,
    norm,
    averageSavingsRate,
    subscriptions,
    subscriptionCurrency,
    subscriptionNorm,
    dueThisWeek,
    staleCount,
    strategyUnavailable,
  };
}

/** Public identity of this vault only, for profile routes and the device's open-vault picker. */
export const profileIdentity = defineQuery({
  id: "core.profileIdentity",
  run: (read): { slug: string; name: string; baseCurrency: string } | null =>
    read<{ slug: string; name: string; baseCurrency: string }>(
      "SELECT slug, name, base_currency AS baseCurrency FROM profiles",
    )[0] ?? null,
});

/**
 * The overview queries of a process, over the device's price cache (null: no cache, last trade
 * prices). The optional process-local change source wakes cache consumers after committed cache
 * writes, independently of the SQL tables each query actually reads.
 */
export function overviewQueries(
  env: { readonly prices: market.PriceCache | null; readonly changes?: ChangeSource },
  sources: OverviewSources = {},
): OverviewQueries {
  const prices = env.prices;
  return {
    ...netWorthQueries(env, sources),
    moduleSetup: defineQuery({
      id: "core.moduleSetup",
      run: (
        read,
        args: { readonly module: string; readonly cli: string; readonly lang: core.UiLang },
      ) => moduleSetup(read, args.module, { cli: args.cli, lang: args.lang }, sources),
    }),
    moduleStates: defineQuery({
      id: "core.moduleStates",
      run: (read) => moduleStates(read, sources),
    }),
    accounts: defineQuery({
      id: "core.overviewAccounts",
      ...(env.changes === undefined ? {} : { changes: env.changes }),
      run: (read, args: { readonly today: IsoDate }) =>
        overviewAccounts(read, vaultNetWorthBook(read, { today: args.today, prices }, sources)),
    }),
    budgetWidgets: defineQuery({
      id: "core.budgetWidgets",
      run: (read, args: { readonly today: IsoDate }) => budgetWidgets(read, args.today, sources),
    }),
    assets: defineQuery({
      id: "core.overviewAssets",
      ...(env.changes === undefined ? {} : { changes: env.changes }),
      run: (read, args: { readonly today: IsoDate }) =>
        overviewAssets(read, vaultNetWorthBook(read, { today: args.today, prices }, sources)),
    }),
    loans: defineQuery({
      id: "core.overviewLoans",
      run: (read, args: { readonly today: IsoDate }) => overviewLoans(read, args.today),
    }),
    investments: defineQuery({
      id: "core.overviewInvestments",
      ...(env.changes === undefined ? {} : { changes: env.changes }),
      run: (read, args: { readonly today: IsoDate; readonly lang: core.UiLang }) =>
        investmentWidgets(read, { today: args.today, lang: args.lang, prices }, sources),
    }),
  };
}
