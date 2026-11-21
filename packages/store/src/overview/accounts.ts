// The account, asset and loan rows of one vault (`@cashu/store/overview/accounts`): the same valued
// book as the net-worth hero, one row per account, manual asset and loan. Its own entry (like
// `./networth.ts` and `./bananas.ts`) so the phone, whose bundler (Metro) does not tree-shake, carries
// these rows without the desktop widgets of `./index.ts`. `overviewQueries` reuses these factories,
// so each id has one definition.
import { type IsoDate, loans } from "@cashu/domain";
import type { market } from "@cashu/domain/investments";
import { profileOf } from "../core/queries.js";
import { mcpLoanRows } from "../loans/mcp-queries.js";
import { type ChangeSource, defineQuery, type Query, type Read } from "../query.js";
import { type OverviewSources, vaultNetWorthBook } from "./networth.js";
import {
  type OverviewAccount,
  type OverviewAsset,
  overviewAccounts,
  overviewAssets,
} from "./widgets.js";

export type { OverviewAccount, OverviewAsset } from "./widgets.js";

type PriceEnv = { readonly prices: market.PriceCache | null; readonly changes?: ChangeSource };

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

/** Every account's net-worth line (`core.overviewAccounts`) over the device's price cache. */
export function accountsQuery(
  env: PriceEnv,
  sources: OverviewSources = {},
): Query<{ readonly today: IsoDate }, OverviewAccount[]> {
  const prices = env.prices;
  return defineQuery({
    id: "core.overviewAccounts",
    ...(env.changes === undefined ? {} : { changes: env.changes }),
    run: (read, args: { readonly today: IsoDate }) =>
      overviewAccounts(read, vaultNetWorthBook(read, { today: args.today, prices }, sources)),
  });
}

/** The manual assets with their valuations (`core.overviewAssets`). */
export function assetsQuery(
  env: PriceEnv,
  sources: OverviewSources = {},
): Query<{ readonly today: IsoDate }, OverviewAsset[]> {
  const prices = env.prices;
  return defineQuery({
    id: "core.overviewAssets",
    ...(env.changes === undefined ? {} : { changes: env.changes }),
    run: (read, args: { readonly today: IsoDate }) =>
      overviewAssets(read, vaultNetWorthBook(read, { today: args.today, prices }, sources)),
  });
}

/** The loans with today's outstanding balance (`core.overviewLoans`); no price input. */
export function loansQuery(): Query<{ readonly today: IsoDate }, readonly OverviewLoan[]> {
  return defineQuery({
    id: "core.overviewLoans",
    run: (read, args: { readonly today: IsoDate }) => overviewLoans(read, args.today),
  });
}
