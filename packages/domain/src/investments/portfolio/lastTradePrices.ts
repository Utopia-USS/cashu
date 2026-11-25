/**
 * Last known trade prices per instrument (`last_trade_prices.py`): the valuation fallback when no
 * market bar exists. Pure.
 */

import { Decimal, ZERO } from "../../decimal.js";
import { TxnSource, TxnType } from "../domain/enums.js";
import type { InstrumentRename } from "../domain/instrument.js";
import { type DatedPrice, datedPrice } from "../domain/snapshot.js";
import type { Transaction } from "../domain/transaction.js";
import {
  type AccountId,
  type CalendarDate,
  daysBetween,
  dividedBy,
  exact,
  type InstrumentId,
} from "../domain/values.js";
import { orderEvents, resolveRedirect } from "./events.js";
import type { Fraction } from "./fraction.js";
import { splitFraction } from "./splitRatio.js";

/**
 * Split transactions of one instrument with the same ratio within this many days are one corporate
 * action (brokers book a split on slightly different days in different accounts).
 */
export const SPLIT_DEDUP_WINDOW_DAYS = 31;

export interface LastTradePricesOptions {
  /** Only rows dated on/before this day (all when omitted). */
  readonly asOf?: CalendarDate | null;
  readonly accountIds?: ReadonlySet<AccountId> | null;
  readonly renames?: readonly InstrumentRename[];
}

/**
 * The newest positive `price` per instrument among market trades (`buy`, `sell`; not
 * `reconciliation` rows) dated on/before `asOf`. Later splits divide the price by their exact ratio
 * (the date stays the trade date), each corporate action once per instrument (same fraction within
 * `SPLIT_DEDUP_WINDOW_DAYS`). A rename hands the old instrument's price to the new one when the new
 * one has none yet. The map keeps Python's dict insertion order.
 */
export const lastTradePrices = exact(
  (
    txns: Iterable<Transaction>,
    options: LastTradePricesOptions = {},
  ): Map<InstrumentId, DatedPrice> => {
    const asOf = options.asOf ?? null;
    const accountIds = options.accountIds ?? null;
    const selected = [...txns].filter(
      (t) =>
        (accountIds === null || accountIds.has(t.accountId)) &&
        (asOf === null || t.tradeDate <= asOf),
    );
    const renames = (options.renames ?? []).filter((r) => asOf === null || r.date <= asOf);

    const prices = new Map<InstrumentId, DatedPrice>();
    const appliedSplits = new Map<InstrumentId, [CalendarDate, Fraction][]>();
    const redirect = new Map<InstrumentId, InstrumentId>();

    for (const event of orderEvents(selected, renames)) {
      if (event.kind === "rename") {
        const old = resolveRedirect(redirect, event.rename.oldInstrumentId);
        const next = resolveRedirect(redirect, event.rename.newInstrumentId);
        if (old === null || next === null || old === next) continue;
        redirect.set(old, next);
        const oldPrice = prices.get(old);
        if (oldPrice !== undefined && !prices.has(next)) prices.set(next, oldPrice);
        continue;
      }
      const txn = event.txn;
      const instrumentId = resolveRedirect(redirect, txn.instrumentId);
      if (instrumentId === null) continue;
      if (txn.type === TxnType.BUY || txn.type === TxnType.SELL) {
        const price = txn.price;
        if (txn.source !== TxnSource.RECONCILIATION && price !== null && price.gt(ZERO)) {
          prices.set(
            instrumentId,
            datedPrice({ date: txn.tradeDate, price, currency: txn.currency }),
          );
        }
      } else if (txn.type === TxnType.SPLIT) {
        if (txn.splitRatio === null || txn.splitRatio.lte(ZERO)) continue;
        const ratio = splitFraction(txn.splitRatio);
        let applied = appliedSplits.get(instrumentId);
        if (applied === undefined) {
          applied = [];
          appliedSplits.set(instrumentId, applied);
        }
        const sameAction = applied.some(
          ([d, r]) =>
            r.eq(ratio) && Math.abs(daysBetween(d, txn.tradeDate)) <= SPLIT_DEDUP_WINDOW_DAYS,
        );
        if (sameAction) continue;
        applied.push([txn.tradeDate, ratio]);
        const last = prices.get(instrumentId);
        if (last !== undefined) {
          prices.set(
            instrumentId,
            datedPrice({
              date: last.date,
              price: dividedBy(
                last.price.mul(Decimal.fromInt(ratio.denominator)),
                Decimal.fromInt(ratio.numerator),
              ),
              currency: last.currency,
            }),
          );
        }
      }
    }
    return prices;
  },
);
