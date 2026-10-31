/**
 * The derived state of a profile (holdings, cash, deposits, realized trades) from its transactions
 * (`snapshot_builder.py`). Pure.
 */

import { ZERO } from "../../decimal.js";
import type { InstrumentRename } from "../domain/instrument.js";
import {
  type Holding,
  holding,
  type OpenLot,
  type PortfolioSnapshot,
  portfolioSnapshot,
} from "../domain/snapshot.js";
import type { Transaction } from "../domain/transaction.js";
import {
  type AccountId,
  type CalendarDate,
  type Currency,
  exact,
  type ProfileId,
} from "../domain/values.js";
import { cashHistoryGap, mixedLotCurrencies, type PortfolioWarning } from "../domain/warnings.js";
import { lastTradePrices } from "./lastTradePrices.js";
import { runLots } from "./lotEngine.js";

export interface BuildSnapshotOptions {
  /** The profile's accounts (null = every account in `txns` belongs to the profile). */
  readonly profileAccounts?: ReadonlySet<AccountId> | null;
  /** Restrict to these accounts. */
  readonly accountIds?: ReadonlySet<AccountId> | null;
  readonly renames?: readonly InstrumentRename[];
}

/**
 * The `PortfolioSnapshot` of a profile as of `asOf`: transactions dated on/before `asOf` of the
 * profile's accounts. Holdings are one per (account, instrument) with a non-zero quantity, in order
 * of first appearance; a holding's currency is its first lot's (several currencies add
 * `MixedLotCurrencies`). A negative cash balance adds a `CashHistoryGap`. Renames dated on/before
 * `asOf` carry lots across.
 */
export const buildSnapshot = exact(
  (
    profileId: ProfileId,
    txns: Iterable<Transaction>,
    asOf: CalendarDate,
    options: BuildSnapshotOptions = {},
  ): PortfolioSnapshot => {
    const profileAccounts = options.profileAccounts ?? null;
    const accountIds = options.accountIds ?? null;
    const scoped = [...txns].filter(
      (t) =>
        t.tradeDate <= asOf &&
        (profileAccounts === null || profileAccounts.has(t.accountId)) &&
        (accountIds === null || accountIds.has(t.accountId)),
    );
    const activeRenames = (options.renames ?? []).filter((r) => r.date <= asOf);
    const result = runLots(scoped, { renames: activeRenames });

    const lotsByPosition = new Map<string, OpenLot[]>();
    for (const lot of result.openLots) {
      const key = `${lot.accountId}\u0000${lot.instrumentId}`;
      const list = lotsByPosition.get(key);
      if (list === undefined) lotsByPosition.set(key, [lot]);
      else list.push(lot);
    }

    const holdings: Holding[] = [];
    const warnings: PortfolioWarning[] = [...result.warnings];
    for (const lots of lotsByPosition.values()) {
      const first = lots[0] as OpenLot;
      const currencies = new Set<Currency>(lots.map((lot) => lot.currency));
      if (currencies.size > 1) {
        warnings.push(
          mixedLotCurrencies({
            accountId: first.accountId,
            instrumentId: first.instrumentId,
            currencies,
          }),
        );
      }
      holdings.push(
        holding({
          accountId: first.accountId,
          instrumentId: first.instrumentId,
          currency: first.currency,
          quantity: lots.reduce((total, lot) => total.add(lot.quantity), ZERO),
          lots,
        }),
      );
    }

    for (const balance of result.cash) {
      if (balance.amount.lt(ZERO)) {
        warnings.push(
          cashHistoryGap({
            accountId: balance.accountId,
            currency: balance.currency,
            amount: balance.amount,
            asOf,
          }),
        );
      }
    }

    return portfolioSnapshot({
      profileId,
      asOf,
      holdings: Object.freeze(holdings),
      cash: result.cash,
      deposits: result.deposits,
      realized: result.realized,
      lastTradePrices: lastTradePrices(scoped, { asOf, renames: activeRenames }),
      warnings: Object.freeze(warnings),
    });
  },
);

/**
 * `snapshot` reduced to `accountIds`: holdings, cash, deposits, realized trades and account-scoped
 * warnings of other accounts are dropped (warnings without an account are kept). `lastTradePrices`
 * stays whole: a price observed in another account is still the instrument's.
 */
export function restrictSnapshot(
  snapshot: PortfolioSnapshot,
  accountIds: ReadonlySet<AccountId>,
): PortfolioSnapshot {
  return portfolioSnapshot({
    profileId: snapshot.profileId,
    asOf: snapshot.asOf,
    holdings: Object.freeze(snapshot.holdings.filter((h) => accountIds.has(h.accountId))),
    cash: Object.freeze(snapshot.cash.filter((c) => accountIds.has(c.accountId))),
    deposits: Object.freeze(snapshot.deposits.filter((d) => accountIds.has(d.accountId))),
    realized: Object.freeze(snapshot.realized.filter((r) => accountIds.has(r.accountId))),
    lastTradePrices: snapshot.lastTradePrices,
    warnings: Object.freeze(
      snapshot.warnings.filter((w) => w.accountId === null || accountIds.has(w.accountId)),
    ),
  });
}
