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
import { budget, core, type IsoDate } from "@cashu/domain";
import type { market } from "@cashu/domain/investments";
import { budgetBook, budgetEngineContext } from "../budget/read-models.js";
import { netWorthBook } from "../core/networth.js";
import { enabledModuleIds, profileOf } from "../core/queries.js";
import { builtinModules } from "../modules.js";
import { defineQuery, type Query, type Read } from "../query.js";
import type { NetWorthEnv, StoreModule } from "../registry.js";

/** What the read models are composed from (the built-in modules and registry by default). */
export interface OverviewSources {
  readonly modules?: readonly StoreModule[];
  readonly registry?: core.CoreRegistry;
}

const modulesOf = (s: OverviewSources): readonly StoreModule[] => s.modules ?? builtinModules();
const registryOf = (s: OverviewSources): core.CoreRegistry => s.registry ?? core.builtinRegistry();

/** The vault's `NetWorthBook` with every module's contributor (Python `networth.valuations`). */
export function vaultNetWorthBook(
  read: Read,
  env: NetWorthEnv,
  sources: OverviewSources = {},
): core.NetWorthBook {
  const contributors: Record<string, core.NetWorthContributor> = {};
  for (const m of modulesOf(sources)) {
    if (m.netWorth !== undefined) contributors[m.id] = m.netWorth(read, env);
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
  readonly summary: Query<{ readonly today: IsoDate }, ShellSummary>;
  readonly hero: Query<{ readonly today: IsoDate }, HeroView>;
  readonly moduleSetup: Query<
    { readonly module: string; readonly cli: string; readonly lang: core.UiLang },
    ModuleSetupResult
  >;
  readonly moduleStates: Query<undefined, ModuleState[]>;
}

/**
 * The overview queries of a process, over the device's price cache (null: no cache, last trade
 * prices). Live: `useQuery` re-runs one when an apply touches a table it read. A price cache write
 * touches no table, so it does not re-run them yet (see the S06b follow-ups).
 */
export function overviewQueries(
  env: { readonly prices: market.PriceCache | null },
  sources: OverviewSources = {},
): OverviewQueries {
  const prices = env.prices;
  return {
    netWorthSeries: defineQuery({
      id: "core.netWorthSeries",
      run: (read, args: SeriesArgs) => netWorthSeries(read, args, { prices }, sources),
    }),
    summary: defineQuery({
      id: "core.summary",
      run: (read, args: { readonly today: IsoDate }) =>
        shellSummary(read, { today: args.today, prices }, sources),
    }),
    hero: defineQuery({
      id: "core.hero",
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
  };
}
