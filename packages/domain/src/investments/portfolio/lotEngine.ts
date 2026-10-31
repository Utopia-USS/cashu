/** FIFO lot matching: transactions -> open lots, realized trades and cash (`lot_engine.py`). Pure. */

import { Decimal, makeContext, ZERO } from "../../decimal.js";
import { TxnType } from "../domain/enums.js";
import type { InstrumentRename } from "../domain/instrument.js";
import {
  type CashBalance,
  cashBalance,
  type DatedAmount,
  datedAmount,
  type OpenLot,
  openLot,
  type RealizedTrade,
  realizedTrade,
} from "../domain/snapshot.js";
import type { Transaction } from "../domain/transaction.js";
import {
  type AccountId,
  type CalendarDate,
  type Currency,
  dividedBy,
  exact,
  type InstrumentId,
  Money,
  type TxnId,
} from "../domain/values.js";
import {
  historyGap,
  invalidTransaction,
  type PortfolioWarning,
  realizedCurrencyMismatch,
  unknownCostBasis,
} from "../domain/warnings.js";
import { orderEvents, resolveRedirect } from "./events.js";
import { FRACTION_ZERO, Fraction } from "./fraction.js";
import { decimalPlaces, splitFraction } from "./splitRatio.js";

/**
 * Units of split dust forgiven when a sell or transfer-out meets a lot. When what a request leaves in
 * the lot has no finite decimal and is within this tolerance of a whole number of units, the lot keeps
 * exactly that whole number (0 = closed; no dust lot, no `HistoryGap`). Remainders with a finite
 * decimal are never snapped.
 */
export const SPLIT_REMAINDER_TOLERANCE: Fraction = Fraction.of(1n, 10n ** 9n);

/** Significant digits of a reported quantity that has no finite decimal (7/15 -> 0.46666666666666666667). */
export const QUANTITY_DIGITS = 20;

const QUANTITY_CONTEXT = makeContext({ prec: QUANTITY_DIGITS, rounding: "ROUND_HALF_UP" });

/** Output of `runLots`. */
export interface LotEngineResult {
  /** Grouped by (account, instrument) in order of first appearance, FIFO order inside a group. */
  readonly openLots: readonly OpenLot[];
  /** FIFO matches of sells, in processing order. */
  readonly realized: readonly RealizedTrade[];
  /** Non-zero cash per (account, currency): the sum of `cashAmount` in `cashCurrency`. */
  readonly cash: readonly CashBalance[];
  /** `deposit` transactions (their `cashAmount` in `cashCurrency`), oldest first. */
  readonly deposits: readonly DatedAmount[];
  /** History gaps, unknown cost bases, currency mismatches and ignored transactions, in order. */
  readonly warnings: readonly PortfolioWarning[];
}

export interface RunLotsOptions {
  /** Only transactions of these accounts are used (all when omitted). */
  readonly accountIds?: ReadonlySet<AccountId> | null;
  readonly renames?: readonly InstrumentRename[];
}

/**
 * FIFO lot engine over `txns` (any order; sorted chronologically here). Port of the Kompas
 * `LotEngine`; the rules are documented on Python's `run_lots`:
 *
 * - `buy` opens a lot (cost = gross + fee + tax); `sell` consumes lots FIFO and realizes the matches
 *   (the last match of a fully covered sell takes the proceeds remainder; a currency mismatch leaves
 *   `pnl` null and adds `RealizedCurrencyMismatch`).
 * - `transfer_in` / `adjustment` open a lot at `price` (missing / zero price = unknown cost,
 *   `UnknownCostBasis`); `transfer_out` consumes FIFO without realizing.
 * - `split` multiplies the open quantities by the exact `splitFraction`; quantities are exact
 *   fractions, matched within `SPLIT_REMAINDER_TOLERANCE` and reported with `QUANTITY_DIGITS` digits.
 * - Overselling records a `HistoryGap`; every `cashAmount` adds to the cash of (account, currency).
 * - `renames` take effect at the start of their date: open lots move to the new instrument.
 */
export const runLots = exact(
  (txns: Iterable<Transaction>, options: RunLotsOptions = {}): LotEngineResult => {
    const accountIds = options.accountIds ?? null;
    const selected = [...txns].filter((t) => accountIds === null || accountIds.has(t.accountId));
    const state = new EngineState();
    for (const event of orderEvents(selected, options.renames ?? [])) {
      if (event.kind === "rename") state.rename(event.rename);
      else state.apply(event.txn);
    }
    return state.result();
  },
);

/** A lot while the engine runs, as an incremental reader sees it (`IncrementalLotEngine`). */
export interface RunningLot {
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly openTxnId: TxnId;
  /** Exact quantity (split ratios applied). */
  readonly quantity: Fraction;
  /** Exact total cost, null when unknown. */
  readonly cost: Decimal | null;
  toOpenLot(): OpenLot;
}

/** The open lots of one (account, instrument), FIFO order. */
export interface RunningQueue {
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly lots: readonly RunningLot[];
}

/** The running cash of one (account, currency). */
export interface RunningCash {
  readonly accountId: AccountId;
  readonly currency: Currency;
  readonly amount: Decimal;
}

/**
 * The lot engine fed one event at a time, for readers that need the state after every day without
 * replaying the history (Python's `performance/series.py` drives the private `_EngineState` the same
 * way). Feed it the events of `orderEvents` in order, inside `exactDecimals` like `runLots`; the
 * queues keep Python's dict order (a group keeps its position; a renamed group moves last).
 */
export class IncrementalLotEngine {
  private readonly state = new EngineState();

  apply(txn: Transaction): void {
    this.state.apply(txn);
  }

  rename(rename: InstrumentRename): void {
    this.state.rename(rename);
  }

  /** Every (account, instrument) queue seen so far, empty ones included. */
  queues(): Iterable<RunningQueue> {
    return this.state.openQueues();
  }

  /** Every (account, currency) cash entry seen so far, zero ones included. */
  cash(): Iterable<RunningCash> {
    return this.state.cashEntries();
  }
}

/** `value` exactly when it has a finite decimal, else rounded to `QUANTITY_DIGITS` digits (half-up). */
export function fractionToDecimal(value: Fraction): Decimal {
  const places = decimalPlaces(value);
  const [numerator, denominator] = value.parts();
  if (places === null) return numerator.div(denominator, QUANTITY_CONTEXT);
  const scaled = value.numerator * (10n ** BigInt(places) / value.denominator);
  // Python builds it from text (`Decimal(f"{n}E-{p}")`), which fixes the exponent at -places.
  return Decimal.parse(`${scaled}E-${places}`);
}

/** `value` rounded like `dividedBy` (half-up, 10 places): unit costs and cost shares. */
function rounded(value: Fraction): Decimal {
  const [numerator, denominator] = value.parts();
  return dividedBy(numerator, denominator);
}

/**
 * The whole number of units a lot keeps when a request would leave `left` (negative: the request
 * exceeds the lot) and `left` is split dust away from it, else null (matched exactly).
 */
function snappedRemainder(left: Fraction): bigint | null {
  if (decimalPlaces(left) !== null) return null;
  const nearest = left.round();
  if (nearest < 0n || left.sub(Fraction.of(nearest)).abs().gt(SPLIT_REMAINDER_TOLERANCE)) {
    return null;
  }
  return nearest;
}

/** A mutable lot while the engine runs: exact quantity, exact total cost (null = unknown). */
class Lot {
  readonly accountId: AccountId;
  instrumentId: InstrumentId;
  readonly openTxnId: TxnId;
  readonly openDate: CalendarDate;
  readonly currency: Currency;
  quantity: Fraction;
  cost: Decimal | null;

  constructor(
    accountId: AccountId,
    instrumentId: InstrumentId,
    openTxnId: TxnId,
    openDate: CalendarDate,
    currency: Currency,
    quantity: Fraction,
    cost: Decimal | null,
  ) {
    this.accountId = accountId;
    this.instrumentId = instrumentId;
    this.openTxnId = openTxnId;
    this.openDate = openDate;
    this.currency = currency;
    this.quantity = quantity;
    this.cost = cost;
  }

  toOpenLot(): OpenLot {
    return openLot({
      accountId: this.accountId,
      instrumentId: this.instrumentId,
      openTxnId: this.openTxnId,
      openDate: this.openDate,
      quantity: fractionToDecimal(this.quantity),
      currency: this.currency,
      unitCost:
        this.cost === null ? null : rounded(Fraction.fromDecimal(this.cost).div(this.quantity)),
    });
  }
}

interface Match {
  readonly lot: Lot;
  /** Units the request matched (reported on the realized trade). */
  readonly quantity: Fraction;
  /** Units taken from the lot: `quantity` except for split dust. */
  readonly taken: Fraction;
  /** Exact cost of `taken`. */
  readonly cost: Decimal | null;
}

interface Queue {
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly lots: Lot[];
}

const pairKey = (a: string, b: string): string => `${a}\u0000${b}`;

class EngineState {
  /** Python dict order: a key keeps its position, a re-inserted key goes last. */
  private readonly lots = new Map<string, Queue>();
  private readonly cash = new Map<
    string,
    { accountId: AccountId; currency: Currency; amount: Decimal }
  >();
  private readonly realized: RealizedTrade[] = [];
  private readonly deposits: DatedAmount[] = [];
  private readonly warnings: PortfolioWarning[] = [];
  private readonly redirect = new Map<InstrumentId, InstrumentId>();

  private resolve(instrumentId: InstrumentId | null): InstrumentId | null {
    return resolveRedirect(this.redirect, instrumentId);
  }

  private queue(accountId: AccountId, instrumentId: InstrumentId): Queue {
    const key = pairKey(accountId, instrumentId);
    let queue = this.lots.get(key);
    if (queue === undefined) {
      queue = { accountId, instrumentId, lots: [] };
      this.lots.set(key, queue);
    }
    return queue;
  }

  rename(rename: InstrumentRename): void {
    const old = this.resolve(rename.oldInstrumentId);
    const next = this.resolve(rename.newInstrumentId);
    if (old === null || next === null || old === next) return;
    this.redirect.set(old, next);
    const moving = [...this.lots.entries()].filter(([, q]) => q.instrumentId === old);
    for (const [key, moved] of moving) {
      this.lots.delete(key);
      for (const lot of moved.lots) lot.instrumentId = next;
      const target = this.queue(moved.accountId, next);
      const merged = [...moved.lots, ...target.lots].sort((a, b) =>
        a.openDate < b.openDate ? -1 : a.openDate > b.openDate ? 1 : 0,
      );
      target.lots.splice(0, target.lots.length, ...merged);
    }
  }

  apply(txn: Transaction): void {
    const key = pairKey(txn.accountId, txn.cashCurrency);
    const balance = this.cash.get(key);
    const amount = (balance?.amount ?? ZERO).add(txn.cashAmount);
    if (balance === undefined) {
      this.cash.set(key, { accountId: txn.accountId, currency: txn.cashCurrency, amount });
    } else {
      balance.amount = amount;
    }
    switch (txn.type) {
      case TxnType.BUY:
        this.open(txn, txn.grossAmount.add(txn.fee).add(txn.tax));
        break;
      case TxnType.TRANSFER_IN:
      case TxnType.ADJUSTMENT:
        this.openAtPrice(txn);
        break;
      case TxnType.SELL:
        this.sell(txn);
        break;
      case TxnType.TRANSFER_OUT: {
        const position = this.position(txn);
        if (position !== null) this.consume(txn, position[0], position[1]);
        break;
      }
      case TxnType.SPLIT:
        this.split(txn);
        break;
      case TxnType.DEPOSIT:
        this.deposits.push(
          datedAmount({
            accountId: txn.accountId,
            date: txn.tradeDate,
            amount: new Money(txn.cashAmount, txn.cashCurrency),
          }),
        );
        break;
      default:
        break; // dividend, withdrawal, fee, tax, interest, fx_conversion: cash only
    }
  }

  private openAtPrice(txn: Transaction): void {
    const { price, quantity } = txn;
    const known = price?.gt(ZERO) ?? false;
    const cost = known && price !== null && quantity !== null ? price.mul(quantity) : null;
    if (this.open(txn, cost) && !known) {
      this.warnings.push(
        unknownCostBasis({
          accountId: txn.accountId,
          instrumentId: this.resolve(txn.instrumentId) as InstrumentId,
          txnId: txn.id,
          date: txn.tradeDate,
        }),
      );
    }
  }

  /** Opens a lot of the transaction's quantity with total `cost`; false (plus a warning) otherwise. */
  private open(txn: Transaction, cost: Decimal | null): boolean {
    const position = this.position(txn);
    if (position === null) return false;
    const [instrumentId, quantity] = position;
    this.queue(txn.accountId, instrumentId).lots.push(
      new Lot(
        txn.accountId,
        instrumentId,
        txn.id,
        txn.tradeDate,
        txn.currency,
        Fraction.fromDecimal(quantity),
        cost,
      ),
    );
    return true;
  }

  private sell(txn: Transaction): void {
    const position = this.position(txn);
    if (position === null) return;
    const [instrumentId, quantity] = position;
    const proceeds = txn.grossAmount.sub(txn.fee).sub(txn.tax);
    const closeUnitPrice = dividedBy(proceeds, quantity);
    const [matches, shortfall] = this.consume(txn, instrumentId, quantity);
    const mismatched = new Set<Currency>();
    let allocated = ZERO;
    const proceedsExact = Fraction.fromDecimal(proceeds);
    const quantityExact = Fraction.fromDecimal(quantity);
    matches.forEach((match, index) => {
      const isLast = index === matches.length - 1 && shortfall.isZero();
      const share = isLast
        ? proceeds.sub(allocated)
        : rounded(proceedsExact.mul(match.quantity).div(quantityExact));
      allocated = allocated.add(share);
      const sameCurrency = match.lot.currency === txn.currency;
      this.realized.push(
        realizedTrade({
          accountId: txn.accountId,
          instrumentId,
          openTxnId: match.lot.openTxnId,
          closeTxnId: txn.id,
          openDate: match.lot.openDate,
          closeDate: txn.tradeDate,
          quantity: fractionToDecimal(match.quantity),
          closeUnitPrice,
          currency: txn.currency,
          costCurrency: match.lot.currency,
          openUnitCost:
            match.cost === null ? null : rounded(Fraction.fromDecimal(match.cost).div(match.taken)),
          pnl: match.cost === null || !sameCurrency ? null : share.sub(match.cost),
        }),
      );
      if (!sameCurrency) mismatched.add(match.lot.currency);
    });
    if (mismatched.size > 0) {
      this.warnings.push(
        realizedCurrencyMismatch({
          accountId: txn.accountId,
          instrumentId,
          txnId: txn.id,
          date: txn.tradeDate,
          saleCurrency: txn.currency,
          lotCurrencies: mismatched,
        }),
      );
    }
  }

  private split(txn: Transaction): void {
    const instrumentId = this.resolve(txn.instrumentId);
    const ratio = txn.splitRatio;
    if (instrumentId === null) {
      this.invalid(txn, "missing instrument");
      return;
    }
    if (ratio === null || ratio.lte(ZERO)) {
      this.invalid(txn, "missing or non-positive split ratio");
      return;
    }
    const exactRatio = splitFraction(ratio);
    const queue = this.lots.get(pairKey(txn.accountId, instrumentId));
    for (const lot of queue?.lots ?? []) lot.quantity = lot.quantity.mul(exactRatio);
  }

  /**
   * Takes `quantity` units FIFO from the lots of (account, instrument); records a `HistoryGap` for
   * any shortfall. A request that would leave split dust leaves a whole number of units instead.
   */
  private consume(
    txn: Transaction,
    instrumentId: InstrumentId,
    quantity: Decimal,
  ): [Match[], Fraction] {
    const queue = this.lots.get(pairKey(txn.accountId, instrumentId))?.lots ?? [];
    const matches: Match[] = [];
    let remaining = Fraction.fromDecimal(quantity);
    while (remaining.gt(FRACTION_ZERO) && queue.length > 0) {
      const lot = queue[0] as Lot;
      const kept = snappedRemainder(lot.quantity.sub(remaining));
      let matched: Fraction;
      let take: Fraction;
      if (kept !== null && Fraction.of(kept).lt(lot.quantity)) {
        matched = remaining;
        take = lot.quantity.sub(Fraction.of(kept));
      } else {
        matched = lot.quantity.lt(remaining) ? lot.quantity : remaining;
        take = matched;
      }
      const lotCost = lot.cost;
      const cost =
        lotCost === null || take.eq(lot.quantity)
          ? lotCost
          : rounded(Fraction.fromDecimal(lotCost).mul(take).div(lot.quantity));
      matches.push({ lot, quantity: matched, taken: take, cost });
      lot.quantity = lot.quantity.sub(take);
      if (lotCost !== null && cost !== null) lot.cost = lotCost.sub(cost);
      if (lot.quantity.isZero()) queue.shift();
      remaining = remaining.sub(matched);
    }
    if (remaining.gt(FRACTION_ZERO)) {
      this.warnings.push(
        historyGap({
          accountId: txn.accountId,
          instrumentId,
          date: txn.tradeDate,
          shortfall: fractionToDecimal(remaining),
          txnId: txn.id,
        }),
      );
    }
    return [matches, remaining];
  }

  /** The (renamed) instrument and a positive quantity of a trade-like transaction, or null. */
  private position(txn: Transaction): [InstrumentId, Decimal] | null {
    const instrumentId = this.resolve(txn.instrumentId);
    if (instrumentId === null) {
      this.invalid(txn, "missing instrument");
      return null;
    }
    if (txn.quantity === null || txn.quantity.isZero()) {
      this.invalid(txn, "missing or zero quantity");
      return null;
    }
    return [instrumentId, txn.quantity];
  }

  private invalid(txn: Transaction, reason: string): void {
    this.warnings.push(
      invalidTransaction({ accountId: txn.accountId, txnId: txn.id, date: txn.tradeDate, reason }),
    );
  }

  openQueues(): Iterable<RunningQueue> {
    return this.lots.values();
  }

  cashEntries(): Iterable<RunningCash> {
    return this.cash.values();
  }

  result(): LotEngineResult {
    return Object.freeze({
      openLots: Object.freeze(
        [...this.lots.values()].flatMap((q) => q.lots.map((lot) => lot.toOpenLot())),
      ),
      realized: Object.freeze([...this.realized]),
      cash: Object.freeze(
        [...this.cash.values()]
          .filter((c) => !c.amount.isZero())
          .map((c) =>
            cashBalance({ accountId: c.accountId, currency: c.currency, amount: c.amount }),
          ),
      ),
      deposits: Object.freeze([...this.deposits]),
      warnings: Object.freeze([...this.warnings]),
    });
  }
}
