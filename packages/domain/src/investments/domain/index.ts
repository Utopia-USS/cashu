/**
 * Investments domain contract (port of `cashu.modules.investments.domain`): pure data, no database,
 * no clock, no I/O.
 *
 * - Ids are branded strings (`ProfileId`, `AccountId`, `InstrumentId`, `TxnId`, `ImportBatchId`) so
 *   global ids fit later; `CalendarDate` is an ISO `YYYY-MM-DD` string; timestamps are `DateTime`.
 * - Money is `Decimal` (never a JS number); ratios and weights are numbers where Python uses float.
 * - Amounts in different currencies are never added; conversion happens only in valuation through an
 *   `FxLookup` (`rate` = units of base per 1 unit of quote, PLN per USD for NBP).
 * - Enums are const objects whose values are the snake_case wire names.
 * - Every value is frozen; Python's `__post_init__` normalization lives in the factory functions
 *   (`instrument()`, `transaction()`, ...), Python's properties in pure functions.
 * - Warnings carry a stable `kind` and an English message; the portfolio math never throws on
 *   incomplete history, it records warnings.
 */

export * from "./buckets.js";
export * from "./enums.js";
export * from "./fx.js";
export * from "./instrument.js";
export * from "./marketData.js";
export * from "./plan.js";
export * from "./snapshot.js";
export * from "./transaction.js";
export * from "./values.js";
export * from "./warnings.js";
