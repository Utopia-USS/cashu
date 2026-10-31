/**
 * Domain enums (`investments/domain/enums.py`). Each value is its snake_case wire name (DB, YAML,
 * import mappings, API, events), so renaming a value is a data migration.
 *
 * Every enum is a const object (`AssetClass.TREASURY_BOND`), a union type of its values, an ordered
 * tuple in declaration order (`ASSET_CLASSES`), a guard and a parser that throws like the Python
 * constructor (`AssetClass("treasury_bond")`).
 */

import { InvariantError } from "./values.js";

type Values<T> = T[keyof T];

function enumParser<V extends string>(name: string, values: readonly V[]): (value: string) => V {
  return (value) => {
    if ((values as readonly string[]).includes(value)) return value as V;
    throw new InvariantError(`${JSON.stringify(value)} is not a valid ${name}`);
  };
}

function enumGuard<V extends string>(values: readonly V[]): (value: unknown) => value is V {
  return (value): value is V =>
    typeof value === "string" && (values as readonly string[]).includes(value);
}

/** Tax wrapper of a broker account. */
export const AccountWrapper = Object.freeze({
  REGULAR: "regular",
  IKE: "ike",
  IKZE: "ikze",
  OIPE: "oipe",
  OTHER: "other",
} as const);
export type AccountWrapper = Values<typeof AccountWrapper>;
export const ACCOUNT_WRAPPERS: readonly AccountWrapper[] = Object.freeze(
  Object.values(AccountWrapper),
);
export const parseAccountWrapper = enumParser("AccountWrapper", ACCOUNT_WRAPPERS);
export const isAccountWrapper = enumGuard(ACCOUNT_WRAPPERS);

/** Asset class of an instrument (also matched by strategy buckets: `asset_class: treasury_bond`). */
export const AssetClass = Object.freeze({
  EQUITY: "equity",
  ETF: "etf",
  FUND: "fund",
  BOND: "bond",
  TREASURY_BOND: "treasury_bond",
  CASH: "cash",
  CRYPTO: "crypto",
  COMMODITY: "commodity",
  /** A claim in insolvency proceedings (e.g. against a bankrupt exchange). */
  CLAIM: "claim",
  OTHER: "other",
} as const);
export type AssetClass = Values<typeof AssetClass>;
export const ASSET_CLASSES: readonly AssetClass[] = Object.freeze(Object.values(AssetClass));
export const parseAssetClass = enumParser("AssetClass", ASSET_CLASSES);
export const isAssetClass = enumGuard(ASSET_CLASSES);

/**
 * Kind of a transaction. Quantities are always >= 0; the direction comes from the type.
 *
 * `ADJUSTMENT` only ever adds units (it opens a lot at `price`, no price meaning unknown cost). A
 * reduction of units is a `TRANSFER_OUT` with `source = reconciliation` (consumes FIFO lots without
 * realizing a trade).
 */
export const TxnType = Object.freeze({
  BUY: "buy",
  SELL: "sell",
  DIVIDEND: "dividend",
  DEPOSIT: "deposit",
  WITHDRAWAL: "withdrawal",
  FEE: "fee",
  TAX: "tax",
  INTEREST: "interest",
  FX_CONVERSION: "fx_conversion",
  SPLIT: "split",
  TRANSFER_IN: "transfer_in",
  TRANSFER_OUT: "transfer_out",
  ADJUSTMENT: "adjustment",
} as const);
export type TxnType = Values<typeof TxnType>;
export const TXN_TYPES: readonly TxnType[] = Object.freeze(Object.values(TxnType));
export const parseTxnType = enumParser("TxnType", TXN_TYPES);
export const isTxnType = enumGuard(TXN_TYPES);

/** Where a transaction came from. */
export const TxnSource = Object.freeze({
  IMPORT: "import",
  MANUAL: "manual",
  RECONCILIATION: "reconciliation",
} as const);
export type TxnSource = Values<typeof TxnSource>;
export const TXN_SOURCES: readonly TxnSource[] = Object.freeze(Object.values(TxnSource));
export const parseTxnSource = enumParser("TxnSource", TXN_SOURCES);
export const isTxnSource = enumGuard(TXN_SOURCES);

/**
 * How holdings of an instrument are valued.
 *
 * - `MARKET`: from daily price bars (stale when the newest bar is too old), falling back to the last
 *   trade price.
 * - `COST`: at the holding's cost basis (base currency at trade-date FX), never stale.
 * - `MANUAL`: at the newest manual valuation on/before the valuation date (0 is valid), never stale.
 */
export const ValuationMode = Object.freeze({
  MARKET: "market",
  COST: "cost",
  MANUAL: "manual",
} as const);
export type ValuationMode = Values<typeof ValuationMode>;
export const VALUATION_MODES: readonly ValuationMode[] = Object.freeze(
  Object.values(ValuationMode),
);
export const parseValuationMode = enumParser("ValuationMode", VALUATION_MODES);
export const isValuationMode = enumGuard(VALUATION_MODES);

/**
 * Lifecycle of an instrument. Delisted and frozen instruments are not fetched from market sources; a
 * frozen holding is valued manually (0 until a manual valuation says otherwise).
 */
export const InstrumentStatus = Object.freeze({
  ACTIVE: "active",
  DELISTED: "delisted",
  FROZEN: "frozen",
} as const);
export type InstrumentStatus = Values<typeof InstrumentStatus>;
export const INSTRUMENT_STATUSES: readonly InstrumentStatus[] = Object.freeze(
  Object.values(InstrumentStatus),
);
export const parseInstrumentStatus = enumParser("InstrumentStatus", INSTRUMENT_STATUSES);
export const isInstrumentStatus = enumGuard(INSTRUMENT_STATUSES);

/** Severity of a signal, declared in ascending order (compare with `severityRank`). */
export const SignalSeverity = Object.freeze({ INFO: "info", ACTION: "action" } as const);
export type SignalSeverity = Values<typeof SignalSeverity>;
export const SIGNAL_SEVERITIES: readonly SignalSeverity[] = Object.freeze(
  Object.values(SignalSeverity),
);
export const parseSignalSeverity = enumParser("SignalSeverity", SIGNAL_SEVERITIES);
export const isSignalSeverity = enumGuard(SIGNAL_SEVERITIES);

/** Lifecycle of a signal. `ACTIVE` and `ACKNOWLEDGED` are "open". */
export const SignalStatus = Object.freeze({
  ACTIVE: "active",
  ACKNOWLEDGED: "acknowledged",
  RESOLVED: "resolved",
  EXPIRED: "expired",
} as const);
export type SignalStatus = Values<typeof SignalStatus>;
export const SIGNAL_STATUSES: readonly SignalStatus[] = Object.freeze(Object.values(SignalStatus));
export const parseSignalStatus = enumParser("SignalStatus", SIGNAL_STATUSES);
export const isSignalStatus = enumGuard(SIGNAL_STATUSES);

/** What the owner did about a signal or on their own. */
export const DecisionAction = Object.freeze({
  BOUGHT: "bought",
  SOLD: "sold",
  HELD: "held",
  IGNORED: "ignored",
  OTHER: "other",
} as const);
export type DecisionAction = Values<typeof DecisionAction>;
export const DECISION_ACTIONS: readonly DecisionAction[] = Object.freeze(
  Object.values(DecisionAction),
);
export const parseDecisionAction = enumParser("DecisionAction", DECISION_ACTIONS);
export const isDecisionAction = enumGuard(DECISION_ACTIONS);

/** Position of `severity` in ascending order (escalation = a higher rank). */
export function severityRank(severity: SignalSeverity): number {
  return SIGNAL_SEVERITIES.indexOf(severity);
}

/** Treasury bonds at cost, claims manually, everything else at market. */
export function defaultValuationMode(assetClass: AssetClass): ValuationMode {
  if (assetClass === AssetClass.TREASURY_BOND) return ValuationMode.COST;
  if (assetClass === AssetClass.CLAIM) return ValuationMode.MANUAL;
  return ValuationMode.MARKET;
}
