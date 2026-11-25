/**
 * Warnings of the portfolio math (`investments/domain/warnings.py`): something it could not do exactly
 * (never an exception).
 *
 * A warning is frozen data with a stable `kind` (snake_case, for persistence and the UI; the union's
 * discriminant) and a short English message (`warningMessage`). `accountId` is the broker account the
 * warning belongs to, or null when it is not account-specific (e.g. a missing price of an instrument
 * that may be held in several accounts). Python warnings collapse in a set by value: `warningKey` /
 * `dedupeWarnings` give the same value identity (decimals by value, sets by members).
 */

import { Decimal, decimalKey } from "../../decimal.js";
import type { AccountId, CalendarDate, Currency, InstrumentId, TxnId } from "./values.js";

// --- lot engine / snapshot ----------------------------------------------------------------------

/**
 * More units were sold / transferred out than the known history holds (expected with incomplete
 * history). The shortfall was ignored, so positions may be understated.
 */
export interface HistoryGap {
  readonly kind: "history_gap";
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly date: CalendarDate;
  readonly shortfall: Decimal;
  readonly txnId: TxnId;
}

/** A transfer in (or an adjustment) opened a lot without a usable price, so its cost is unknown. */
export interface UnknownCostBasis {
  readonly kind: "unknown_cost_basis";
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly txnId: TxnId;
  readonly date: CalendarDate;
}

/**
 * A transaction lacks a field its type needs (instrument, quantity, split ratio) and was ignored for
 * lots. Its `cashAmount` still counts towards cash.
 */
export interface InvalidTransaction {
  readonly kind: "invalid_transaction";
  readonly accountId: AccountId;
  readonly txnId: TxnId;
  readonly date: CalendarDate;
  readonly reason: string;
}

/**
 * Lots of one instrument in one account carry different currencies; `holdingCostBasis` /
 * `holdingAverageCost` are null (never summed across currencies). Valuation converts each lot alone.
 */
export interface MixedLotCurrencies {
  readonly kind: "mixed_lot_currencies";
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly currencies: ReadonlySet<Currency>;
}

/**
 * A sell was booked in another currency than the lots it closed: the realized trades keep proceeds
 * and cost in their own currencies, their `pnl` is null, valuation reports the base-currency result.
 */
export interface RealizedCurrencyMismatch {
  readonly kind: "realized_currency_mismatch";
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly txnId: TxnId;
  readonly date: CalendarDate;
  readonly saleCurrency: Currency;
  readonly lotCurrencies: ReadonlySet<Currency>;
}

/**
 * The cash of an account in one currency is negative as of the snapshot date: deposits (or sells,
 * dividends) are missing from the imported history. Valuation counts the balance as 0 in totals and
 * weights; cash rules skip while any such gap exists.
 */
export interface CashHistoryGap {
  readonly kind: "cash_history_gap";
  readonly accountId: AccountId;
  readonly currency: Currency;
  /** The (negative) balance. */
  readonly amount: Decimal;
  readonly asOf: CalendarDate;
}

// --- valuation ----------------------------------------------------------------------------------

/**
 * The newest rate converting `currency` to `base` for `date` is more than `max_fx_age_days` old. It is
 * not used: the amount is treated like one without any rate (see `MissingFxRate`).
 */
export interface StaleFxRate {
  readonly kind: "stale_fx_rate";
  readonly accountId: null;
  readonly currency: Currency;
  readonly base: Currency;
  /** The date the rate was needed for. */
  readonly date: CalendarDate;
  readonly rateDate: CalendarDate;
  readonly ageDays: number;
}

/**
 * No usable FX rate on/before `date` converts `currency` to `base`: the affected amount is left out and
 * weight rules skip while a holding or cash balance lacks a valuation-date rate.
 */
export interface MissingFxRate {
  readonly kind: "missing_fx_rate";
  readonly accountId: null;
  readonly currency: Currency;
  readonly base: Currency;
  readonly date: CalendarDate;
}

/**
 * No price for a held instrument (no bar on/before the valuation date, no last trade price): the
 * holding is excluded from totals and weights.
 */
export interface MissingPrice {
  readonly kind: "missing_price";
  readonly accountId: null;
  readonly instrumentId: InstrumentId;
  readonly asOf: CalendarDate;
}

/** No market bar: the holding was valued at the last trade price and counts as stale. */
export interface LastKnownPriceUsed {
  readonly kind: "last_known_price_used";
  readonly accountId: null;
  readonly instrumentId: InstrumentId;
  readonly priceDate: CalendarDate;
  readonly price: Decimal;
}

/** The newest bar of a held instrument is older than the allowed price age. */
export interface StalePrice {
  readonly kind: "stale_price";
  readonly accountId: null;
  readonly instrumentId: InstrumentId;
  readonly priceDate: CalendarDate;
  readonly ageDays: number;
}

/**
 * A held instrument has no metadata in the `MarketView`; a placeholder (asset class `other`, needs
 * classification) was used, so it matches no bucket that needs metadata.
 */
export interface MissingInstrument {
  readonly kind: "missing_instrument";
  readonly accountId: null;
  readonly instrumentId: InstrumentId;
}

/**
 * A holding valued at cost has an unknown cost basis (or no FX rate for a lot): excluded from totals
 * and weights like an unpriced holding.
 */
export interface MissingCostBasis {
  readonly kind: "missing_cost_basis";
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
}

/**
 * An instrument valued manually has no manual valuation on/before the valuation date: excluded from
 * totals and weights like an unpriced holding.
 */
export interface MissingManualValuation {
  readonly kind: "missing_manual_valuation";
  readonly accountId: null;
  readonly instrumentId: InstrumentId;
  readonly asOf: CalendarDate;
}

/** A frozen instrument without a manual valuation is valued at 0 (until the owner sets one). */
export interface FrozenValuedAtZero {
  readonly kind: "frozen_valued_at_zero";
  readonly accountId: null;
  readonly instrumentId: InstrumentId;
}

/** Every portfolio warning (Python's `PortfolioWarning` subclasses). */
export type PortfolioWarning =
  | HistoryGap
  | UnknownCostBasis
  | InvalidTransaction
  | MixedLotCurrencies
  | RealizedCurrencyMismatch
  | CashHistoryGap
  | StaleFxRate
  | MissingFxRate
  | MissingPrice
  | LastKnownPriceUsed
  | StalePrice
  | MissingInstrument
  | MissingCostBasis
  | MissingManualValuation
  | FrozenValuedAtZero;

export type WarningKind = PortfolioWarning["kind"];

/** `ALL_WARNING_TYPES`: every concrete warning kind, in the Python declaration order. */
export const ALL_WARNING_KINDS: readonly WarningKind[] = Object.freeze([
  "history_gap",
  "unknown_cost_basis",
  "invalid_transaction",
  "mixed_lot_currencies",
  "realized_currency_mismatch",
  "cash_history_gap",
  "stale_fx_rate",
  "missing_fx_rate",
  "missing_price",
  "last_known_price_used",
  "stale_price",
  "missing_instrument",
  "missing_cost_basis",
  "missing_manual_valuation",
  "frozen_valued_at_zero",
] as const);

type Fields<W extends PortfolioWarning> = Omit<W, "kind" | "accountId">;
type AccountFields<W extends PortfolioWarning> = Omit<W, "kind">;

function freeze<W extends PortfolioWarning>(warning: W): W {
  return Object.freeze(warning);
}

export const historyGap = (f: AccountFields<HistoryGap>): HistoryGap =>
  freeze({ kind: "history_gap", ...f });
export const unknownCostBasis = (f: AccountFields<UnknownCostBasis>): UnknownCostBasis =>
  freeze({ kind: "unknown_cost_basis", ...f });
export const invalidTransaction = (f: AccountFields<InvalidTransaction>): InvalidTransaction =>
  freeze({ kind: "invalid_transaction", ...f });
export const mixedLotCurrencies = (
  f: Omit<AccountFields<MixedLotCurrencies>, "currencies"> & {
    readonly currencies: Iterable<Currency>;
  },
): MixedLotCurrencies =>
  freeze({ kind: "mixed_lot_currencies", ...f, currencies: new Set(f.currencies) });
export const realizedCurrencyMismatch = (
  f: Omit<AccountFields<RealizedCurrencyMismatch>, "lotCurrencies"> & {
    readonly lotCurrencies: Iterable<Currency>;
  },
): RealizedCurrencyMismatch =>
  freeze({ kind: "realized_currency_mismatch", ...f, lotCurrencies: new Set(f.lotCurrencies) });
export const cashHistoryGap = (f: AccountFields<CashHistoryGap>): CashHistoryGap =>
  freeze({ kind: "cash_history_gap", ...f });
export const staleFxRate = (f: Fields<StaleFxRate>): StaleFxRate =>
  freeze({ kind: "stale_fx_rate", accountId: null, ...f });
export const missingFxRate = (f: Fields<MissingFxRate>): MissingFxRate =>
  freeze({ kind: "missing_fx_rate", accountId: null, ...f });
export const missingPrice = (f: Fields<MissingPrice>): MissingPrice =>
  freeze({ kind: "missing_price", accountId: null, ...f });
export const lastKnownPriceUsed = (f: Fields<LastKnownPriceUsed>): LastKnownPriceUsed =>
  freeze({ kind: "last_known_price_used", accountId: null, ...f });
export const stalePrice = (f: Fields<StalePrice>): StalePrice =>
  freeze({ kind: "stale_price", accountId: null, ...f });
export const missingInstrument = (f: Fields<MissingInstrument>): MissingInstrument =>
  freeze({ kind: "missing_instrument", accountId: null, ...f });
export const missingCostBasis = (f: AccountFields<MissingCostBasis>): MissingCostBasis =>
  freeze({ kind: "missing_cost_basis", ...f });
export const missingManualValuation = (f: Fields<MissingManualValuation>): MissingManualValuation =>
  freeze({ kind: "missing_manual_valuation", accountId: null, ...f });
export const frozenValuedAtZero = (f: Fields<FrozenValuedAtZero>): FrozenValuedAtZero =>
  freeze({ kind: "frozen_valued_at_zero", accountId: null, ...f });

function join(currencies: ReadonlySet<Currency>): string {
  return [...currencies].sort().join(", ");
}

function assertNever(value: never): never {
  throw new Error(`unknown warning ${JSON.stringify(value)}`);
}

/** `PortfolioWarning.message` (and `str(warning)`): the short English text, byte-equal to Python. */
export function warningMessage(w: PortfolioWarning): string {
  switch (w.kind) {
    case "history_gap":
      return `History gap: ${w.txnId} on ${w.date} needs ${w.shortfall.toString()} more units of ${w.instrumentId} than held`;
    case "unknown_cost_basis":
      return `Unknown cost basis: ${w.txnId} on ${w.date} opened a lot of ${w.instrumentId} without a price`;
    case "invalid_transaction":
      return `Ignored transaction ${w.txnId} on ${w.date} for lots: ${w.reason}`;
    case "mixed_lot_currencies":
      return `Lots of ${w.instrumentId} in one account use several currencies: ${join(w.currencies)}`;
    case "realized_currency_mismatch":
      return `Sale ${w.txnId} of ${w.instrumentId} on ${w.date} is in ${w.saleCurrency} but closed lots in ${join(w.lotCurrencies)}: realized result only in the base currency`;
    case "cash_history_gap":
      return `Cash history gap: ${w.currency} cash of ${w.accountId} is ${w.amount.toString()} on ${w.asOf} (deposits missing from the history?); counted as 0`;
    case "stale_fx_rate":
      return `Stale ${w.currency}/${w.base} FX rate for ${w.date}: newest rate ${w.rateDate} is ${w.ageDays} days old`;
    case "missing_fx_rate":
      return `No ${w.currency}/${w.base} FX rate on or before ${w.date}`;
    case "missing_price":
      return `No price for ${w.instrumentId} on or before ${w.asOf}: excluded from weights`;
    case "last_known_price_used":
      return `No market price for ${w.instrumentId}: valued at the last known price ${w.price.toString()} from ${w.priceDate}`;
    case "stale_price":
      return `Stale price for ${w.instrumentId}: last close ${w.priceDate} is ${w.ageDays} days old`;
    case "missing_instrument":
      return `No instrument metadata for ${w.instrumentId}: valued with a placeholder`;
    case "missing_cost_basis":
      return `Cannot value ${w.instrumentId} at cost: its cost basis is unknown, excluded from weights`;
    case "missing_manual_valuation":
      return `No manual valuation of ${w.instrumentId} on or before ${w.asOf}: excluded from weights`;
    case "frozen_valued_at_zero":
      return `${w.instrumentId} is frozen and has no manual valuation: valued at 0`;
    default:
      return assertNever(w);
  }
}

/**
 * Value identity of a warning (Python dataclass `__eq__` / `__hash__`): decimals by value
 * (`1.0` = `1`), sets by sorted members, fields sorted by name.
 */
export function warningKey(w: PortfolioWarning): string {
  const entries = Object.entries(w).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = entries.map(([field, value]) => {
    if (value instanceof Decimal) return [field, decimalKey(value)];
    if (value instanceof Set) return [field, [...value].map(String).sort()];
    return [field, value];
  });
  return JSON.stringify(parts);
}

/** Python `set(warnings)` keeping the first occurrence's order: duplicates by value collapse. */
export function dedupeWarnings(warnings: Iterable<PortfolioWarning>): PortfolioWarning[] {
  const seen = new Set<string>();
  const out: PortfolioWarning[] = [];
  for (const w of warnings) {
    const key = warningKey(w);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(w);
    }
  }
  return out;
}
