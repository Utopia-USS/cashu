/**
 * Producer of `core.overview` (`parity/python/checks/core.py:overview`): per profile, the shell
 * summary (`GET /summary`), the net-worth series view (`GET /networth/series`: every granularity and
 * scope per currency of the profile's accounts, the default request, the labels in English), every
 * module's blank-page status in both languages and the profile's module states. The values are the
 * route's JSON floats (`f()` = `float(Decimal)`).
 *
 * Every number and text comes from `@cashu/domain` (core overview, budget analytics, module setup
 * steps) over the read-only source; only the setup facts are counted here from the source's rows, as
 * each module's `setup.py` counts them.
 */

import { assets, budget, core, D, type Decimal, investments, loans, ZERO } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import { budgetBook } from "../budget/book.ts";
import { type OutValue, pyFloat } from "../output.ts";
import { profileBook } from "./book.ts";

const REGISTRY = core.builtinRegistry();
const NOT_SUBSCRIPTION = budget.subscriptionExclusions(REGISTRY);
/** `runtime.cli_program()` outside the packaged app (the golden child runs from the venv). */
const CLI_PROGRAM = ["cashu"];
const SERIES_VIEWS = (["daily", "weekly", "monthly"] as const).flatMap((g) =>
  (["total", "liquid"] as const).map((sc) => [g, sc] as const),
);
const LANGS: readonly core.UiLang[] = ["pl", "en"];

/** `f()`: a Decimal as the API's JSON number. */
const f = (d: Decimal): OutValue => pyFloat(d.toFloat());
const fRecord = (r: Readonly<Record<string, Decimal>>): OutValue =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, f(v)]));

function breakdownOut(bd: core.NetWorthBreakdown): OutValue {
  return {
    currency: bd.currency,
    assets: f(bd.assets),
    liabilities: f(bd.liabilities),
    net: f(bd.net),
    property: f(bd.propertyValue),
    mortgage: f(bd.mortgage),
    home_equity: f(bd.homeEquity),
    by_type: Object.fromEntries([...bd.byType].map(([k, v]) => [k, f(v)])),
  };
}

function seriesOut(view: core.SeriesView): OutValue {
  return {
    currency: view.currency,
    points: view.points.map((p) => ({
      date: p.date,
      value: f(p.value),
      components: fRecord(p.components),
    })),
    components: componentsOut(view),
  };
}

const componentsOut = (view: core.SeriesView): OutValue =>
  view.components.map((c) => ({ key: c.key, label: c.label, liability: c.liability }));

// --------------------------------------------------------------------------- setup facts

/** `budget/setup.py`: counts over the profile's bank accounts (not the manual institution). */
function budgetFacts(db: PythonDb, profileId: number): budget.BudgetSetupFacts {
  const banks = new Set(
    db
      .accounts(profileId, { includeRemoved: true })
      .filter((a) => a.bank !== core.MANUAL_INSTITUTION)
      .map((a) => a.id),
  );
  const txns = db.transactions(profileId).filter((t) => banks.has(t.accountId));
  return {
    bankAccounts: banks.size,
    transactions: txns.length,
    uncategorized: txns.filter((t) => D(t.amount).lt(ZERO) && t.categorySource === "default")
      .length,
    manualDecisions:
      db.categoryRules(profileId).filter((r) => r.source === "manual").length +
      txns.filter((t) => t.categorySource === "manual_txn").length,
    internalTransfers: txns.filter((t) => t.isInternalTransfer).length,
    ownMoves: txns.filter((t) => t.category === "transfer").length,
  };
}

/** `loans/setup.py`. */
function loansFacts(db: PythonDb, profileId: number): loans.LoansSetupFacts {
  const rows = db.loansAssets.loans(profileId);
  return {
    loans: rows.length,
    paymentMatching: rows.some((l) => !!l.paymentIban || !!l.paymentText),
    budgetEnabled: db.enabledModules(profileId).includes("budget"),
    categorizedInstallments: db
      .transactions(profileId)
      .some((t) => t.category === core.LOANS_CATEGORY),
  };
}

/** `assets/setup.py`: non-removed positions; the vehicles among them with a curve. */
function assetsFacts(db: PythonDb, profileId: number): assets.AssetsSetupFacts {
  const types = new Set(assets.SETUP_POSITION_TYPES);
  const positions = db.accounts(profileId).filter((a) => types.has(a.type));
  const vehicles = new Set(positions.filter((a) => a.type === "vehicle").map((a) => a.id));
  const curves = db.loansAssets.depreciations(profileId).filter((d) => vehicles.has(d.accountId));
  return {
    positions: positions.length,
    vehicles: vehicles.size,
    depreciatingVehicles: curves.length,
  };
}

/** `investments/setup.py`: the strategy file in the profile's data folder. */
function investmentsFacts(
  db: PythonDb,
  profileId: number,
  slug: string,
): investments.InvestmentsSetupFacts {
  return {
    hasAccount: db
      .accounts(profileId, { includeRemoved: true })
      .some((a) => a.type === core.BROKERAGE),
    hasStrategy: db.files().read(`profiles/${slug}/strategy.yaml`) !== undefined,
    hasTransaction: db.investments.transactions(profileId).length > 0,
    hasRun: db.investments.hasFinishedRuleRun(profileId),
  };
}

function setupSteps(
  db: PythonDb,
  profileId: number,
  slug: string,
  moduleId: string,
  ctx: core.SetupContext,
): core.SetupStep[] {
  switch (moduleId) {
    case "budget":
      return budget.budgetSetupSteps(budgetFacts(db, profileId), ctx);
    case "loans":
      return loans.loansSetupSteps(loansFacts(db, profileId), ctx);
    case "assets":
      return assets.assetsSetupSteps(assetsFacts(db, profileId), ctx);
    case "investments":
      return investments.investmentsSetupSteps(investmentsFacts(db, profileId, slug), ctx);
    default:
      return [];
  }
}

// --------------------------------------------------------------------------- per profile

function profileOut(
  db: PythonDb,
  p: { id: number; slug: string; baseCurrency: string | null },
): OutValue {
  const { book } = profileBook(db, REGISTRY, p.id);
  const summary = core.netWorthSummary(book, p.baseCurrency);
  const bBook = budgetBook(db, p.id, p.baseCurrency);
  const ctx: budget.EngineContext = {
    ownIbans: core.ownIbans(bBook.accounts),
    rules: budget.rulesByMerchant(
      db.categoryRules(p.id).map((r) => ({ ...r, source: r.source as budget.RuleSource })),
    ),
    patterns: db.loanPaymentPatterns(p.id),
    moduleTextRules: core.textRules(REGISTRY),
  };
  const active = budget.activeRecurring(
    budget.recurringPayments(bBook, ctx, NOT_SUBSCRIPTION),
    bBook,
  );
  const month = budget.monthSummary(budget.monthlyCashflow(bBook));
  const subs = budget.subscriptionsSummary(active);

  const view = (
    currency: string | null,
    granularity: string,
    scope: string,
    lang: core.UiLang = "pl",
  ) =>
    core.seriesView(
      book,
      core.seriesRequest({ currency, granularity, scope, baseCurrency: p.baseCurrency }),
      lang,
    );
  const currencies = [
    ...new Set(db.accounts(p.id, { includeRemoved: true }).map((a) => a.currency)),
  ].sort();
  const series: Record<string, OutValue> = {};
  for (const c of currencies) {
    series[c] = Object.fromEntries(
      SERIES_VIEWS.map(([g, sc]) => [`${g}_${sc}`, seriesOut(view(c, g, sc))]),
    );
  }

  const cli = core.cliPrefix(CLI_PROGRAM, p.slug);
  const setup: Record<string, OutValue> = {};
  for (const lang of LANGS) {
    for (const spec of REGISTRY.modules.values()) {
      const v = core.setupView(setupSteps(db, p.id, p.slug, spec.id, { cli, lang }));
      setup[`${spec.id}_${lang}`] = {
        state: v.state,
        steps: v.steps.map((st) => ({
          id: st.id,
          title: st.title,
          description: st.description,
          status: st.status,
          optional: st.optional,
          actions: st.actions.map((a) => ({ kind: a.kind, label: a.label, target: a.target })),
        })),
        cli_prefix: cli,
        skill: spec.skill,
      };
    }
  }
  const enabled = new Set(db.enabledModules(p.id));
  return {
    summary: {
      networth: fRecord(summary.networth),
      breakdown: breakdownOut(summary.breakdown),
      month:
        month === null
          ? null
          : {
              label: month.label,
              income: f(month.income),
              expense: f(month.expense),
              net: f(month.net),
            },
      subscriptions: {
        count: BigInt(subs.count),
        monthly_total: f(subs.monthlyTotal),
        monthly_totals: fRecord(subs.monthlyTotals),
      },
    },
    series_default: seriesOut(view(null, "daily", "total")),
    series,
    series_labels_en: componentsOut(view(null, "monthly", "total", "en")),
    setup,
    modules: [...REGISTRY.modules.values()].map((spec) => {
      const state = core.setupState(setupSteps(db, p.id, p.slug, spec.id, { cli, lang: "pl" }));
      return { id: spec.id, enabled: enabled.has(spec.id), setup_state: state };
    }),
  };
}

export function produceOverview(db: PythonDb): OutValue {
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) out[db.keys.key("profiles", p.id)] = profileOut(db, p);
  return out;
}
