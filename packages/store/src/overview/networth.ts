// The net-worth read models of one vault (`@cashu/store/overview/networth`): the net-worth history,
// the shell summary and the hero facts, composed from core and every module's registered net-worth
// contributor. The rest of the overview (module setup, the desktop widgets with their investments
// close) lives in `./index.ts`; this file stays apart so the phone, whose bundler (Metro) does not
// tree-shake, carries these read models without the desktop widgets.
import { budget, core, type IsoDate } from "@cashu/domain";
import { InMemoryFxLookup, market, toCurrency } from "@cashu/domain/investments";
import { budgetBook, budgetEngineContext } from "../budget/read-models.js";
import { netWorthBook } from "../core/networth.js";
import { profileOf } from "../core/queries.js";
import type { OverviewRequest } from "../investments/views/overview.js";
import { builtinModules } from "../modules.js";
import { type ChangeSource, defineQuery, type Query, type Read } from "../query.js";
import type { NetWorthEnv, StoreModule } from "../registry.js";

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

/** @package */
export const modulesOf = (s: OverviewSources): readonly StoreModule[] =>
  s.modules ?? builtinModules();
/** @package */
export const registryOf = (s: OverviewSources): core.CoreRegistry =>
  s.registry ?? core.builtinRegistry();

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

/**
 * The NBP rates of the device's price cache as a `core.RateAt` into `target`: the newest rate on or
 * before the day, cross rates through PLN. Without a price cache no rate is known.
 */
export function vaultRateAt(
  read: Read,
  env: Omit<NetWorthEnv, "today">,
  sources: OverviewSources,
  target: string,
): core.RateAt {
  const data =
    env.marketData ??
    sources.marketData?.(read) ??
    (env.prices === null ? null : market.cachedMarketData(env.prices, []));
  if (data === null) return () => null;
  const currencies = read<{ currency: string }>(
    "SELECT DISTINCT currency FROM accounts WHERE removed_at IS NULL ORDER BY currency",
  ).map((r) => r.currency);
  const lookup = new InMemoryFxLookup(
    [...new Set([...currencies, target])].flatMap((c) => data.fxRates(toCurrency(c))),
  );
  return (currency, on) => {
    const q = lookup.quoteOnOrBefore(toCurrency(currency), on, toCurrency(target));
    return q === null ? null : { rate: q.rate, date: q.date };
  };
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
  /**
   * Convert every other currency into `currency` at the NBP rate of each day and sum them
   * (`core.convertedSeriesView`); default: that currency alone.
   */
  readonly convert?: boolean | null;
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
  if (!args.convert) return core.seriesView(book, request, args.lang);
  const rateAt = vaultRateAt(read, env, sources, request.currency);
  return core.convertedSeriesView(book, request, args.lang, rateAt);
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
  /**
   * The facts with every other currency converted into the headline one at today's NBP rate; null
   * when the profile holds one currency only.
   */
  readonly converted: core.ConvertedHero | null;
  /** Monthly spending of complete months in the headline currency; null without data. */
  readonly norm: budget.MonthNorm | null;
  /** `liquid / norm.expense`; null without a norm. */
  readonly monthsOfSpending: core.HeroFacts["liquid"] | null;
  /**
   * Net worth change since the previous month end (monthly total series, converted when `converted`
   * is set, whole points only); null below 2 such points.
   */
  readonly change: core.NetWorthChange | null;
}

/** The hero strip of the overview (the SPA's NetHero computed it from three responses). */
export function heroView(read: Read, env: NetWorthEnv, sources: OverviewSources = {}): HeroView {
  const parts = summaryParts(read, env, sources);
  const facts = core.heroFacts(parts.core);
  const rows = budget
    .wholeMonths(
      budget.monthlyCashflow(parts.book, facts.currency),
      budget.cashflowCoverageStart(parts.book, facts.currency),
    )
    .slice(-HERO_CASHFLOW_MONTHS);
  const norm = budget.closedMonthNorm(rows, env.today);
  const rateAt = vaultRateAt(read, env, sources, facts.currency);
  const converted = core.convertedHero(parts.netWorth, parts.core, facts, rateAt, env.today);
  const request: core.SeriesRequest = {
    currency: facts.currency,
    granularity: "monthly",
    scope: "total",
  };
  const monthly =
    converted?.rateDate == null
      ? core.seriesView(parts.netWorth, request, "pl")
      : core.convertedSeriesView(parts.netWorth, request, "pl", rateAt);
  return {
    facts,
    converted,
    norm,
    monthsOfSpending: core.monthsOfSpending(facts.liquid, norm?.expense ?? null),
    // Only whole points: one that misses accounts with later data is no starting value.
    change: core.netWorthChange(core.completePoints(monthly)),
  };
}

// --------------------------------------------------------------------------- queries

export interface NetWorthQueries {
  readonly netWorthSeries: Query<SeriesArgs, core.SeriesView>;
  readonly summary: Query<{ readonly today: IsoDate }, ShellSummarySnapshot>;
  readonly hero: Query<{ readonly today: IsoDate }, HeroView>;
}

/** The net-worth queries over one price cache (`overviewQueries` includes them; same ids). */
export function netWorthQueries(
  env: { readonly prices: market.PriceCache | null; readonly changes?: ChangeSource },
  sources: OverviewSources = {},
): NetWorthQueries {
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
  };
}
