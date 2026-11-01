/**
 * Producer of `budget.month_close` (`parity/python/checks/budget.py:month_close`): per profile, the
 * stored budget settings and the close of the default month and of the six months up to as_of, each as
 * the raw `MonthClose` and as the API view (`as_dict`, amounts as Python floats).
 *
 * Inputs: the profile's rows (`book.ts`), `profiles/<slug>/budget.json` from the dataset copy
 * (`budget.loadBudgetSettings`), the balances through `core.latestBalancePerAccount` (budget's cash
 * pool and the brokerage contributors), the enabled modules and, for a profile with investments, the
 * strategy's contributions plan from the strategy bridge (TRANSITIONAL(S14): read from the TS strategy
 * loader once it lands, with the bridge).
 */

import { budget, core, D, type Decimal } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import { brokerageContributor } from "../investments/brokerage.ts";
import type { StrategyBridge } from "../investments/strategyBridge.ts";
import { type OutValue, pyFloat } from "../output.ts";
import { budgetBook } from "./book.ts";

const REGISTRY = core.builtinRegistry();
/**
 * TRANSITIONAL(S11): the loans / assets contributors are not ported yet; a cushion account of their
 * types would be valued from snapshots instead of by its module, so such a close is refused.
 */
const UNPORTED_TYPES: ReadonlySet<string> = new Set(
  ["loans", "assets"].flatMap((m) => core.getModule(REGISTRY, m).accountTypes.map((t) => t.id)),
);

function balancesOf(db: PythonDb, profileId: number, book: budget.BudgetBook): budget.CushionEnv {
  const balances = new Map<string, core.BalanceSnapshot[]>();
  for (const b of db.balances(profileId)) {
    const id = db.keys.key("accounts", b.accountId);
    const list = balances.get(id) ?? [];
    list.push({ date: b.date, amount: D(b.amount), source: b.source });
    balances.set(id, list);
  }
  const nw: core.NetWorthBook = {
    accounts: book.accounts,
    balances,
    contributors: core.orderContributors(REGISTRY, {
      budget: budget.cashContributor(book.transactions),
      investments: brokerageContributor(db, profileId),
    }),
    types: REGISTRY.accountTypes,
    today: db.asOf,
  };
  return {
    latestAt: (asOf) => core.latestBalancePerAccount(nw, asOf),
    types: REGISTRY.accountTypes,
  };
}

const f = (d: Decimal) => pyFloat(d.toFloat());
const fOrNull = (d: Decimal | null) => (d === null ? null : f(d));
const intOrNull = (n: number | null) => (n === null ? null : BigInt(n));
const decimals = (m: ReadonlyMap<string, Decimal>) =>
  Object.fromEntries(m) as Record<string, Decimal>;

function rawOut(close: budget.MonthClose): OutValue {
  const c = close.cushion;
  const p = close.planned;
  return {
    year: BigInt(close.year),
    month: BigInt(close.month),
    complete: close.complete,
    base_currency: close.baseCurrency,
    first_month: close.firstMonth,
    last_month: close.lastMonth,
    investments_enabled: close.investmentsEnabled,
    currencies: close.currencies.map((cc) => ({
      currency: cc.currency,
      income: cc.income,
      spending: cc.spending,
      income_by_category: decimals(cc.incomeByCategory),
      spending_by_category: decimals(cc.spendingByCategory),
      transactions: BigInt(cc.transactions),
      cushion_top_up: cc.cushionTopUp,
    })),
    cushion:
      c === null
        ? null
        : {
            currency: c.currency,
            target: c.target,
            target_source: c.targetSource,
            target_months: intOrNull(c.targetMonths),
            balance: c.balance,
            missing: c.missing,
            top_up: c.topUp,
            accounts: c.accounts.map((a) => a.id),
            average_spending: c.averageSpending,
          },
    planned:
      p === null
        ? null
        : {
            strategy_state: p.strategyState,
            amount: p.amount,
            currency: p.currency,
            day_of_month: intOrNull(p.dayOfMonth),
          },
  };
}

function categoriesOut(rows: readonly budget.CategoryAmount[]): OutValue {
  return rows.map((r) => ({ category: r.category, label: r.label, amount: f(r.amount) }));
}

function apiOut(view: budget.MonthCloseView): OutValue {
  const c = view.cushion;
  const inv = view.investing;
  return {
    month: view.month,
    complete: view.complete,
    base_currency: view.baseCurrency,
    first_month: view.firstMonth,
    last_month: view.lastMonth,
    currencies: view.currencies.map((cc) => ({
      currency: cc.currency,
      income: f(cc.income),
      spending: f(cc.spending),
      surplus: f(cc.surplus),
      cushion_top_up: f(cc.cushionTopUp),
      suggested_transfer: f(cc.suggestedTransfer),
      transactions: BigInt(cc.transactions),
      income_by_category: categoriesOut(cc.incomeByCategory),
      spending_by_category: categoriesOut(cc.spendingByCategory),
    })),
    cushion:
      c === null
        ? null
        : {
            enabled: true,
            currency: c.currency,
            target: fOrNull(c.target),
            target_source: c.targetSource,
            target_months: intOrNull(c.targetMonths),
            average_spending: fOrNull(c.averageSpending),
            balance: f(c.balance),
            missing: f(c.missing),
            top_up: f(c.topUp),
            reached: c.reached,
            accounts: c.accounts.map((a) => ({ id: a.id, name: a.name })),
          },
    investing:
      inv === null
        ? null
        : {
            enabled: true,
            strategy_state: inv.strategyState,
            planned:
              inv.planned === null
                ? null
                : {
                    amount: f(inv.planned.amount),
                    currency: inv.planned.currency,
                    day_of_month: intOrNull(inv.planned.dayOfMonth),
                  },
            comparison:
              inv.comparison === null
                ? null
                : {
                    currency: inv.comparison.currency,
                    has_data: inv.comparison.hasData,
                    surplus: f(inv.comparison.surplus),
                    suggested_transfer: f(inv.comparison.suggestedTransfer),
                    difference: f(inv.comparison.difference),
                    status: inv.comparison.status,
                  },
          },
  };
}

function settingsOut(s: budget.BudgetSettings): OutValue {
  const c = s.cushion;
  return {
    cushion: {
      enabled: c.enabled,
      currency: c.currency,
      target_amount: c.targetAmount,
      target_months: intOrNull(c.targetMonths),
      account_ids: [...c.accountIds],
      monthly_max: c.monthlyMax,
    },
  };
}

function profileOut(
  db: PythonDb,
  profile: ReturnType<PythonDb["profiles"]>[number],
  strategies: StrategyBridge,
): OutValue {
  const book = budgetBook(db, profile.id, profile.baseCurrency);
  const stored = budget.loadBudgetSettings(db.dataFile(`profiles/${profile.slug}/budget.json`));
  // Python ids -> the book's ids (natural keys), as canon.py writes `account_ids`.
  const settings: budget.BudgetSettings = {
    cushion: {
      ...stored.cushion,
      accountIds: stored.cushion.accountIds.map((id) => db.keys.key("accounts", id)),
    },
  };
  if (settings.cushion.enabled) {
    const currency = settings.cushion.currency || book.baseCurrency;
    const unported = budget
      .cushionAccounts(book, settings.cushion, currency)
      .filter((a) => UNPORTED_TYPES.has(a.type));
    if (unported.length > 0) {
      throw new Error("a cushion account is valued by the loans / assets module (not ported, S11)");
    }
  }
  const investmentsEnabled = db.enabledModules(profile.id).includes("investments");
  let planned: budget.PlannedContribution | null = null;
  if (investmentsEnabled) {
    const s = strategies.get(db.keys.key("profiles", profile.id));
    if (s === undefined)
      throw new Error("the strategy bridge has no entry for an investments profile");
    planned = budget.plannedContribution(
      s.state,
      s.strategy === null
        ? null
        : { baseCurrency: s.strategy.baseCurrency, contributions: s.contributions },
    );
  }
  const env = balancesOf(db, profile.id, book);
  const close = (year: number | null, month: number | null) =>
    budget.monthClose(book, {
      year,
      month,
      today: db.asOf,
      settings,
      env,
      investmentsEnabled,
      planned,
    });
  const entry = (c: budget.MonthClose): OutValue => ({
    api: apiOut(budget.monthCloseView(c)),
    raw: rawOut(c),
  });
  const closes: Record<string, OutValue> = { default: entry(close(null, null)) };
  const [ay, am] = [Number(db.asOf.slice(0, 4)), Number(db.asOf.slice(5, 7))];
  for (let back = 0; back < 6; back++) {
    const [y, m] = budget.shiftMonth(ay, am, -back);
    closes[budget.monthLabel(y, m)] = entry(close(y, m));
  }
  return { settings: settingsOut(settings), closes };
}

export function produceBudgetMonthClose(db: PythonDb, strategies: StrategyBridge): OutValue {
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) out[db.keys.key("profiles", p.id)] = profileOut(db, p, strategies);
  return out;
}
