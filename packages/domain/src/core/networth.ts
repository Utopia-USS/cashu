/**
 * Net worth: per-currency totals, assets vs liabilities, history by bucket (`core/networth.py`).
 *
 * The sign, liquidity and chart bucket of each account come from the account type registry. Totals
 * are per currency and never summed across currencies (no FX conversion here).
 *
 * Python reads the profile's accounts and balances through the session on every call; here the
 * caller (the store) hands over a `NetWorthBook` with the profile's rows and the module contributors
 * already built, and every function is pure over it.
 */

import { type IsoDate, isoCalendar, parseDate } from "../dates.js";
import type { Decimal } from "../decimal.js";
import { type AccountTypeRegistry, bucketLabel, type NetWorthBucket } from "./accountTypes.js";
import type { UiLang } from "./i18n.js";
import {
  type BalanceSnapshot,
  type NetWorthAccount,
  type NetWorthContributor,
  resolveValuations,
  type Valuation,
} from "./valuation.js";
import { ZERO_00 } from "./zero.js";

/** One profile's net-worth inputs. The store scopes every row to the profile before building it. */
export interface NetWorthBook {
  /** The profile's accounts in storage order (removed ones may be included; they are skipped). */
  readonly accounts: readonly NetWorthAccount[];
  /** Balance snapshots per account id, each list in storage order. */
  readonly balances: ReadonlyMap<string, readonly BalanceSnapshot[]>;
  /** Module contributors in module display order (`orderContributors`); the first one wins. */
  readonly contributors: readonly NetWorthContributor[];
  /** Sign, liquidity and bucket per account type (`CoreRegistry.accountTypes`). */
  readonly types: AccountTypeRegistry;
  /** Today's local date: "now" for computed valuations (Python's `date.today()`). */
  readonly today: IsoDate;
}

// --------------------------------------------------------------------------- account semantics

/**
 * Signed contribution of an account balance to net worth:
 * - credit (credit card): a positive balance is the limit / available credit (contributes 0); only a
 *   negative booked balance is real debt;
 * - liability (mortgage, loan): stored as the outstanding principal, subtracts;
 * - asset (cash, savings, investment, property, ...): adds at face value.
 */
export function contribution(
  types: AccountTypeRegistry,
  account: NetWorthAccount,
  amount: Decimal | null,
): Decimal | null {
  return amount === null ? null : signedAmount(types, account, amount);
}

/** `contribution` of a known amount. */
export function signedAmount(
  types: AccountTypeRegistry,
  account: NetWorthAccount,
  amount: Decimal,
): Decimal {
  const sign = types.get(account.type).sign;
  switch (sign) {
    case "credit":
      // Python min(amount, ZERO): ZERO only when it is strictly smaller.
      return ZERO_00.lt(amount) ? ZERO_00 : amount;
    case "liability":
      return amount.abs().neg();
    case "asset":
      return amount;
    default: {
      const never: never = sign;
      throw new Error(`unknown sign ${String(never)}`);
    }
  }
}

/** Which net-worth bucket an account contributes to (unknown types -> money). */
export function bucketOf(types: AccountTypeRegistry, account: NetWorthAccount): string {
  return types.get(account.type).bucket;
}

export function isLiability(types: AccountTypeRegistry, account: NetWorthAccount): boolean {
  return types.get(account.type).sign !== "asset";
}

/** `component_order`: bucket ids in stacking order. */
export function componentOrder(types: AccountTypeRegistry): string[] {
  return types.buckets().map((b) => b.id);
}

/** `liability_components`: ids of the liability buckets. */
export function liabilityComponents(types: AccountTypeRegistry): Set<string> {
  return new Set(
    types
      .buckets()
      .filter((b) => b.liability)
      .map((b) => b.id),
  );
}

/** `component_labels`: bucket labels in the UI language. */
export function componentLabels(types: AccountTypeRegistry, lang: UiLang): Map<string, string> {
  return new Map(types.buckets().map((b: NetWorthBucket) => [b.id, bucketLabel(b, lang)]));
}

// --------------------------------------------------------------------------- net worth now

function visibleAccounts(book: NetWorthBook): NetWorthAccount[] {
  return book.accounts.filter((a) => a.removedAt === null);
}

function valuationsFor(
  book: NetWorthBook,
  accounts: readonly NetWorthAccount[],
): Map<string, Valuation> {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return resolveValuations(book.contributors, byId, book.balances);
}

/**
 * `latest_balance_per_account`: the most recent value per (non-removed) account as of `asOf` (now
 * when null). Accounts a module values get that module's value for the date.
 */
export function latestBalancePerAccount(
  book: NetWorthBook,
  asOf: IsoDate | null = null,
): Map<string, readonly [IsoDate, Decimal]> {
  const out = new Map<string, readonly [IsoDate, Decimal]>();
  for (const [id, v] of valuationsFor(book, visibleAccounts(book))) {
    const entry = v.latest(asOf, book.today);
    if (entry !== null) out.set(id, entry);
  }
  return out;
}

export interface NetWorthLine {
  readonly account: NetWorthAccount;
  readonly asOf: IsoDate | null;
  /** Raw reported balance; null = no balance data. */
  readonly amount: Decimal | null;
  readonly isLiability: boolean;
  readonly contribution: Decimal | null;
}

export interface NetWorth {
  /** Per currency, never summed across currencies. */
  readonly totals: Map<string, Decimal>;
  /** One line per active, non-removed account, in storage order. */
  readonly lines: NetWorthLine[];
}

/** `net_worth`: totals per currency and one line per active account, as of `asOf` (now when null). */
export function netWorth(book: NetWorthBook, asOf: IsoDate | null = null): NetWorth {
  const accounts = visibleAccounts(book).filter((a) => a.active);
  const latest = latestBalancePerAccount(book, asOf);
  const lines: NetWorthLine[] = [];
  const totals = new Map<string, Decimal>();
  for (const account of accounts) {
    const entry = latest.get(account.id);
    const amount = entry ? entry[1] : null;
    const c = contribution(book.types, account, amount);
    lines.push({
      account,
      asOf: entry ? entry[0] : null,
      amount,
      isLiability: isLiability(book.types, account),
      contribution: c,
    });
    if (c !== null) totals.set(account.currency, (totals.get(account.currency) ?? ZERO_00).add(c));
  }
  return { totals, lines };
}

export interface NetWorthBreakdown {
  readonly currency: string;
  readonly assets: Decimal;
  /** Positive magnitude of debts. */
  readonly liabilities: Decimal;
  readonly net: Decimal;
  readonly propertyValue: Decimal;
  readonly mortgage: Decimal;
  readonly homeEquity: Decimal;
  readonly byType: Map<string, Decimal>;
}

/** `net_worth_breakdown`: assets vs liabilities (+ property / mortgage / equity) in one currency, now. */
export function netWorthBreakdown(book: NetWorthBook, currency: string): NetWorthBreakdown {
  const accounts = visibleAccounts(book).filter((a) => a.active && a.currency === currency);
  const latest = latestBalancePerAccount(book);
  let assets = ZERO_00;
  let liabilities = ZERO_00;
  let prop = ZERO_00;
  let mort = ZERO_00;
  const byType = new Map<string, Decimal>();
  for (const a of accounts) {
    const entry = latest.get(a.id);
    if (entry === undefined) continue;
    const raw = entry[1];
    const c = signedAmount(book.types, a, raw);
    byType.set(a.type, (byType.get(a.type) ?? ZERO_00).add(c));
    if (c.gte(ZERO_00)) assets = assets.add(c);
    else liabilities = liabilities.add(c.neg());
    const bucket = bucketOf(book.types, a);
    if (bucket === "property") prop = prop.add(raw);
    else if (bucket === "mortgage") mort = mort.add(raw.abs());
  }
  return {
    currency,
    assets,
    liabilities,
    net: assets.sub(liabilities),
    propertyValue: prop,
    mortgage: mort,
    homeEquity: prop.sub(mort),
    byType,
  };
}

// --------------------------------------------------------------------------- history

export type Granularity = "daily" | "weekly" | "monthly";
export type SeriesScope = "total" | "liquid";

/** Keep the last value in each week / month (period-end net worth); the series is ascending. */
function resamplePeriodEnd<T>(
  series: readonly (readonly [IsoDate, T])[],
  granularity: "weekly" | "monthly",
): [IsoDate, T][] {
  const buckets = new Map<string, [IsoDate, T]>();
  for (const [d, v] of series) {
    let key: string;
    if (granularity === "monthly") {
      const { year, month } = parseDate(d);
      key = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
    } else {
      const [year, week] = isoCalendar(d);
      key = `${String(year).padStart(4, "0")}-${String(week).padStart(2, "0")}`;
    }
    buckets.set(key, [d, v]);
  }
  return [...buckets.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

/**
 * `net_worth_component_series`: net worth over time in one currency, split into display buckets
 * (`componentOrder`); the buckets sum to the total at each date. Points sit on the dates where some
 * account's value is known (balance snapshots, cash movements); computed values (loans, vehicles)
 * are evaluated at those dates. Inactive accounts count here (as in Python); removed ones do not.
 */
export function netWorthComponentSeries(
  book: NetWorthBook,
  currency: string,
  granularity: Granularity = "daily",
  scope: SeriesScope = "total",
): [IsoDate, Map<string, Decimal>][] {
  let accounts = visibleAccounts(book).filter((a) => a.currency === currency);
  if (scope === "liquid") accounts = accounts.filter((a) => book.types.get(a.type).liquid);
  if (accounts.length === 0) return [];

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const vals = valuationsFor(book, accounts);
  const axis = new Set<IsoDate>();
  for (const v of vals.values()) for (const d of v.axisDates()) axis.add(d);

  let series: [IsoDate, Map<string, Decimal>][] = [];
  for (const d of [...axis].sort()) {
    const comps = new Map<string, Decimal>();
    for (const [id, v] of vals) {
      const account = byId.get(id);
      if (account === undefined)
        throw new Error("a contributor valued an account it was not given");
      const c = contribution(book.types, account, v.at(d));
      if (c !== null) {
        const key = bucketOf(book.types, account);
        comps.set(key, (comps.get(key) ?? ZERO_00).add(c));
      }
    }
    series.push([d, comps]);
  }
  if (granularity === "weekly" || granularity === "monthly") {
    series = resamplePeriodEnd(series, granularity);
  }
  return series;
}

/** `net_worth_series`: the net worth total over time (sum of the component buckets). */
export function netWorthSeries(
  book: NetWorthBook,
  currency: string,
  granularity: Granularity = "daily",
  scope: SeriesScope = "total",
): [IsoDate, Decimal][] {
  return netWorthComponentSeries(book, currency, granularity, scope).map(([d, comps]) => {
    let total = ZERO_00;
    for (const v of comps.values()) total = total.add(v);
    return [d, total];
  });
}
