// The overview read models of one vault (`@cashu/store/overview`), composed from core and every
// module's registered sources (`StoreModule.netWorth` / `.setup`), as Python's composition layer did
// (`api/app.py` `/summary`, `core/api.py` `/networth/series` and `/modules/{id}/setup`,
// `profiles.as_dict` setup states): the net-worth history view, the shell summary, the hero facts and
// each module's blank-page status. Core never imports a module; this folder sits above both, like
// `modules.ts`.
//
// Net worth reads the device's price cache besides the view (brokerage valuation), so the queries are
// built once per process over that cache (`overviewQueries`); their ids stay stable. Heavy work stays
// here (one book per run, in the store process), never in render.
import { budget, core, D, type Decimal, type IsoDate, loans } from "@cashu/domain";
import type { market } from "@cashu/domain/investments";
import { performance as perf } from "@cashu/domain/investments";
import { budgetCliCushionEnv, budgetCliSettings } from "../budget/cli-queries.js";
import { budgetBook, budgetEngineContext } from "../budget/read-models.js";
import { netWorthBook } from "../core/networth.js";
import { enabledModuleIds, profileOf } from "../core/queries.js";
import { performanceInputs } from "../investments/performance/inputs.js";
import { plannedDeposits } from "../investments/queries/planned.js";
import { monthPlan } from "../investments/services/planned.js";
import { type OverviewRequest, readOverview } from "../investments/views/overview.js";
import { mcpLoanRows } from "../loans/mcp-queries.js";
import { builtinModules } from "../modules.js";
import { type ChangeSource, defineQuery, type Query, type Read } from "../query.js";
import type { NetWorthEnv, StoreModule } from "../registry.js";
import {
  type OverviewAccount,
  type OverviewAsset,
  overviewAccounts,
  overviewAssets,
} from "./widgets.js";

export { type CashWalletView, cashWallet, overviewCashWallet } from "./widgets.js";

/** What the read models are composed from (the built-in modules and registry by default). */
export interface OverviewSources {
  /** Exact imported and public market data resolved against the current vault's read. */
  readonly marketData?: (read: Read) => market.CachedMarketData | null;
  readonly modules?: readonly StoreModule[];
  readonly registry?: core.CoreRegistry;
  /** Vault-scoped, authoritative strategy plan; absent means the investment close is unavailable. */
  readonly plannedContribution?: (read: Read) => budget.PlannedContribution | null;
  /** Explicit current vault/strategy/market binding; no inferred file or lease authority. */
  readonly investmentRequest?: (
    read: Read,
    context: {
      readonly today: IsoDate;
      readonly lang: core.UiLang;
      readonly prices: market.PriceCache | null;
    },
  ) => OverviewRequest | null;
}

const modulesOf = (s: OverviewSources): readonly StoreModule[] => s.modules ?? builtinModules();
const registryOf = (s: OverviewSources): core.CoreRegistry => s.registry ?? core.builtinRegistry();

/** The vault's `NetWorthBook` with every module's contributor (Python `networth.valuations`). */
export function vaultNetWorthBook(
  read: Read,
  env: NetWorthEnv,
  sources: OverviewSources = {},
): core.NetWorthBook {
  const marketData = env.marketData ?? sources.marketData?.(read) ?? undefined;
  const contributors: Record<string, core.NetWorthContributor> = {};
  for (const m of modulesOf(sources)) {
    if (m.netWorth !== undefined) contributors[m.id] = m.netWorth(read, { ...env, marketData });
  }
  return netWorthBook(read, contributors, env.today, registryOf(sources));
}

/** Every module's payment patterns (what the categorization of an undecided row reads). */
export function vaultPaymentPatterns(
  read: Read,
  sources: OverviewSources = {},
): core.PaymentPattern[] {
  const reader = { all: read };
  return modulesOf(sources).flatMap((m) => [...(m.contributions?.paymentPatterns?.(reader) ?? [])]);
}

// --------------------------------------------------------------------------- series

// A type alias, not an interface: query args must satisfy the JSON `QueryArgs` index signature.
export type SeriesArgs = {
  readonly today: IsoDate;
  readonly lang: core.UiLang;
  /** Default: the profile's base currency. */
  readonly currency?: string | null;
  /** `daily` (default), `weekly` or `monthly` (period-end value). */
  readonly granularity?: string | null;
  /** `total` (default) or `liquid`. */
  readonly scope?: string | null;
};

/** `GET /networth/series`. */
export function netWorthSeries(
  read: Read,
  args: SeriesArgs,
  env: Omit<NetWorthEnv, "today">,
  sources: OverviewSources = {},
): core.SeriesView {
  const request = core.seriesRequest({
    currency: args.currency ?? null,
    granularity: args.granularity ?? null,
    scope: args.scope ?? null,
    baseCurrency: profileOf(read)?.baseCurrency,
  });
  const book = vaultNetWorthBook(read, { ...env, today: args.today }, sources);
  return core.seriesView(book, request, args.lang);
}

// --------------------------------------------------------------------------- summary

export interface ShellSummary {
  /** Net worth per currency, code order (never summed across currencies). */
  readonly networth: Readonly<Record<string, core.NetWorthSummary["networth"][string]>>;
  /** Assets vs liabilities in the headline currency. */
  readonly breakdown: core.NetWorthBreakdown;
  /** The newest month of the base-currency cashflow; null without any. */
  readonly month: budget.MonthSummary | null;
  readonly subscriptions: budget.SubscriptionsSummary;
}

/** Live query shape: exact domain values, with the breakdown map represented as a JSON object. */
export interface ShellSummarySnapshot extends Omit<ShellSummary, "breakdown"> {
  readonly breakdown: Omit<core.NetWorthBreakdown, "byType"> & {
    readonly byType: Readonly<Record<string, core.NetWorthBreakdown["net"]>>;
  };
}

interface SummaryParts {
  readonly netWorth: core.NetWorthBook;
  readonly core: core.NetWorthSummary;
  readonly book: budget.BudgetBook;
}

function summaryParts(read: Read, env: NetWorthEnv, sources: OverviewSources): SummaryParts {
  const netWorth = vaultNetWorthBook(read, env, sources);
  const nw = core.netWorthSummary(netWorth, profileOf(read)?.baseCurrency);
  return { netWorth, core: nw, book: budgetBook(read) };
}

/** `GET /summary`: net worth now, the headline breakdown, the latest month, active subscriptions. */
export function shellSummary(
  read: Read,
  env: NetWorthEnv,
  sources: OverviewSources = {},
): ShellSummary {
  const parts = summaryParts(read, env, sources);
  const registry = registryOf(sources);
  const ctx = budgetEngineContext(read, vaultPaymentPatterns(read, sources), registry);
  const candidates = budget.recurringPayments(
    parts.book,
    ctx,
    budget.subscriptionExclusions(registry),
  );
  return {
    networth: parts.core.networth,
    breakdown: parts.core.breakdown,
    month: budget.monthSummary(budget.monthlyCashflow(parts.book)),
    subscriptions: budget.subscriptionsSummary(budget.activeRecurring(candidates, parts.book)),
  };
}

// --------------------------------------------------------------------------- hero

/** The cashflow window the hero's spending norm reads (the SPA asked for the last 7 months). */
export const HERO_CASHFLOW_MONTHS = 7;

export interface HeroView {
  readonly facts: core.HeroFacts;
  /** Monthly spending of complete months in the headline currency; null without data. */
  readonly norm: budget.MonthNorm | null;
  /** `liquid / norm.expense`; null without a norm. */
  readonly monthsOfSpending: core.HeroFacts["liquid"] | null;
  /** Net worth change since the previous month end (monthly total series); null below 2 points. */
  readonly change: core.NetWorthChange | null;
}

/** The hero strip of the overview (the SPA's NetHero computed it from three responses). */
export function heroView(read: Read, env: NetWorthEnv, sources: OverviewSources = {}): HeroView {
  const parts = summaryParts(read, env, sources);
  const facts = core.heroFacts(parts.core);
  const rows = budget.monthlyCashflow(parts.book, facts.currency).slice(-HERO_CASHFLOW_MONTHS);
  const norm = budget.closedMonthNorm(rows, env.today);
  const monthly = core.seriesView(
    parts.netWorth,
    { currency: facts.currency, granularity: "monthly", scope: "total" },
    "pl",
  );
  return {
    facts,
    norm,
    monthsOfSpending: core.monthsOfSpending(facts.liquid, norm?.expense ?? null),
    change: core.netWorthChange(monthly.points),
  };
}

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

export interface OverviewQueries {
  readonly netWorthSeries: Query<SeriesArgs, core.SeriesView>;
  readonly summary: Query<{ readonly today: IsoDate }, ShellSummarySnapshot>;
  readonly hero: Query<{ readonly today: IsoDate }, HeroView>;
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
      readonly openPlans: readonly {
        readonly gid: string;
        readonly amount: Decimal;
        readonly currency: string;
        readonly plannedDate: string;
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
    openPlans: plannedDeposits(read, ["planned"]).map((row) => ({
      gid: row.gid,
      amount: row.amount,
      currency: row.currency,
      plannedDate: row.plannedDate,
    })),
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
    readonly suggestedTransfer: Decimal | null;
    readonly currency: string;
    readonly otherCurrencies: readonly string[];
  } | null;
  readonly norm: budget.MonthNorm | null;
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
  const norm = budget.closedMonthNorm(budget.monthlyCashflow(book, base), today);
  const closed = budget
    .monthlyCashflow(book, base)
    .filter((row) => row.label < today.slice(0, 7))
    .slice(-6);
  const averageSavingsRate =
    closed.length < 2
      ? null
      : closed
          .reduce(
            (sum, row) => sum.add(row.income.isZero() ? D("0") : row.net.div(row.income)),
            D("0"),
          )
          .div(D(String(closed.length)));
  const subscriptionNorm = budget.closedMonthNorm(
    budget.monthlyCashflow(book, subscriptionCurrency),
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
  const fallback = budget.monthSummary(budget.monthlyCashflow(book, base));
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

/** Explicit matching legacy identity only. It grants no financial writer coherence or authority. */
export function legacyNavigation(
  available?: (vault: string, slug: string) => boolean,
): Query<undefined, boolean> {
  return defineQuery({
    id: "core.legacyNavigation",
    run: (read) => {
      const profile = read<{ gid: string; slug: string }>("SELECT gid, slug FROM profiles")[0];
      return profile !== undefined && available?.(profile.gid, profile.slug) === true;
    },
  });
}

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
    netWorthSeries: defineQuery({
      id: "core.netWorthSeries",
      ...(env.changes === undefined ? {} : { changes: env.changes }),
      run: (read, args: SeriesArgs) => netWorthSeries(read, args, { prices }, sources),
    }),
    summary: defineQuery({
      id: "core.summary",
      ...(env.changes === undefined ? {} : { changes: env.changes }),
      run: (read, args: { readonly today: IsoDate }): ShellSummarySnapshot => {
        const value = shellSummary(read, { today: args.today, prices }, sources);
        return {
          ...value,
          breakdown: { ...value.breakdown, byType: Object.fromEntries(value.breakdown.byType) },
        };
      },
    }),
    hero: defineQuery({
      id: "core.hero",
      ...(env.changes === undefined ? {} : { changes: env.changes }),
      run: (read, args: { readonly today: IsoDate }) =>
        heroView(read, { today: args.today, prices }, sources),
    }),
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
