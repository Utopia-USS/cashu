/**
 * Typed readers of the investments module's tables, part of the read-only source (`db.investments`).
 *
 * Profile data is scoped like the Python store (`store/transactions.py`, `store/instruments.py`):
 * transactions through the profile's brokerage accounts (removed ones included, as
 * `brokerage_accounts` does), renames, manual valuations and instrument overrides by `profile_id`.
 * Instruments, aliases, price bars and FX rates are shared reference data (no profile). Decimals stay
 * the stored text (`DecimalText`), timestamps the stored naive-UTC text, JSON lists are parsed.
 */

import {
  bool,
  boolOrNull,
  int,
  intOrNull,
  type Row,
  stringListOrNull,
  text,
  textOrNull,
} from "./decode.ts";

type Param = string | number | bigint | null;
type Query = (sql: string, ...params: Param[]) => Row[];

/** Account type id owned by the investments module (`store/transactions.py:BROKERAGE`). */
const BROKERAGE = "brokerage";

export interface InvTransactionRow {
  readonly id: number;
  readonly accountId: number;
  readonly type: string;
  readonly tradeDate: string;
  readonly settleDate: string | null;
  readonly instrumentId: number | null;
  readonly quantity: string | null;
  readonly price: string | null;
  readonly currency: string;
  readonly grossAmount: string;
  readonly fee: string | null;
  readonly tax: string | null;
  readonly cashAmount: string;
  readonly cashCurrency: string;
  readonly fxRate: string | null;
  readonly splitRatio: string | null;
  readonly note: string | null;
  readonly source: string;
  readonly importBatchId: number | null;
  readonly externalRef: string | null;
  readonly dedupHash: string;
  /** Stored naive-UTC timestamp text. */
  readonly createdAt: string;
}

export interface InvRenameRow {
  readonly id: number;
  readonly date: string;
  readonly oldInstrumentId: number;
  readonly newInstrumentId: number;
  readonly note: string | null;
}

export interface InvInstrumentRow {
  readonly id: number;
  readonly name: string;
  readonly currency: string;
  readonly assetClass: string;
  readonly symbol: string | null;
  readonly isin: string | null;
  readonly mic: string | null;
  readonly region: string | null;
  readonly sector: string | null;
  readonly tags: readonly string[];
  readonly needsClassification: boolean;
  readonly valuationMode: string;
  readonly status: string;
}

export interface InvAliasRow {
  readonly id: number;
  readonly instrumentId: number;
  readonly namespace: string;
  readonly value: string;
  readonly guessed: boolean;
}

/** A profile's view of an instrument (`inv_profile_instruments`); null = keep the shared value. */
export interface InvProfileInstrumentRow {
  readonly instrumentId: number;
  readonly name: string | null;
  readonly assetClass: string | null;
  readonly tags: readonly string[] | null;
  readonly region: string | null;
  readonly sector: string | null;
  readonly valuationMode: string | null;
  readonly status: string | null;
  readonly needsClassification: boolean | null;
  readonly plan: string | null;
  readonly planAt: string | null;
  readonly planReason: string | null;
  readonly segment: string | null;
  readonly segmentBy: string | null;
}

export interface InvManualValuationRow {
  readonly id: number;
  readonly instrumentId: number;
  readonly asOf: string;
  readonly unitValue: string;
  readonly currency: string;
  readonly note: string | null;
}

export interface InvPriceBarRow {
  readonly instrumentId: number;
  readonly date: string;
  readonly close: string;
  readonly open: string | null;
  readonly high: string | null;
  readonly low: string | null;
  readonly volume: number | null;
  readonly currency: string | null;
  readonly source: string;
  readonly fetchedAt: string | null;
}

export interface InvFxRateRow {
  readonly base: string;
  readonly quote: string;
  readonly date: string;
  readonly rate: string;
  readonly source: string;
  readonly fetchedAt: string | null;
}

/** The account fields the readers need (`PythonDb.accounts` rows). */
interface ProfileAccount {
  readonly id: number;
  readonly type: string;
}

const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

export class InvestmentsReader {
  private readonly query: Query;
  private readonly accounts: (profileId: number) => readonly ProfileAccount[];

  constructor(query: Query, accounts: (profileId: number) => readonly ProfileAccount[]) {
    this.query = query;
    this.accounts = accounts;
  }

  /** The profile's brokerage accounts, oldest first (removed ones included). */
  brokerageAccounts(profileId: number): ProfileAccount[] {
    return this.accounts(profileId).filter((a) => a.type === BROKERAGE);
  }

  /** Transactions of the profile's brokerage accounts in `(trade_date, created_at, id)` order. */
  transactions(profileId: number): InvTransactionRow[] {
    const ids = this.brokerageAccounts(profileId).map((a) => a.id);
    if (ids.length === 0) return [];
    return this.query(
      `SELECT id, account_id, type, trade_date, settle_date, instrument_id, quantity, price,
              currency, gross_amount, fee, tax, cash_amount, cash_currency, fx_rate, split_ratio,
              note, source, import_batch_id, external_ref, dedup_hash, created_at
       FROM inv_transactions WHERE account_id IN (${placeholders(ids.length)})
       ORDER BY trade_date, created_at, id`,
      ...ids,
    ).map((r) => ({
      id: int(r, "id"),
      accountId: int(r, "account_id"),
      type: text(r, "type"),
      tradeDate: text(r, "trade_date"),
      settleDate: textOrNull(r, "settle_date"),
      instrumentId: intOrNull(r, "instrument_id"),
      quantity: textOrNull(r, "quantity"),
      price: textOrNull(r, "price"),
      currency: text(r, "currency"),
      grossAmount: text(r, "gross_amount"),
      fee: textOrNull(r, "fee"),
      tax: textOrNull(r, "tax"),
      cashAmount: text(r, "cash_amount"),
      cashCurrency: text(r, "cash_currency"),
      fxRate: textOrNull(r, "fx_rate"),
      splitRatio: textOrNull(r, "split_ratio"),
      note: textOrNull(r, "note"),
      source: text(r, "source"),
      importBatchId: intOrNull(r, "import_batch_id"),
      externalRef: textOrNull(r, "external_ref"),
      dedupHash: text(r, "dedup_hash"),
      createdAt: text(r, "created_at"),
    }));
  }

  /** The profile's instrument renames in `(date, id)` order. */
  renames(profileId: number): InvRenameRow[] {
    return this.query(
      `SELECT id, date, old_instrument_id, new_instrument_id, note FROM inv_instrument_renames
       WHERE profile_id = ? ORDER BY date, id`,
      profileId,
    ).map((r) => ({
      id: int(r, "id"),
      date: text(r, "date"),
      oldInstrumentId: int(r, "old_instrument_id"),
      newInstrumentId: int(r, "new_instrument_id"),
      note: textOrNull(r, "note"),
    }));
  }

  /** Shared instrument rows of `ids`, in id order. */
  instruments(ids: readonly number[]): InvInstrumentRow[] {
    if (ids.length === 0) return [];
    return this.query(
      `SELECT id, name, currency, asset_class, symbol, isin, mic, region, sector, tags,
              needs_classification, valuation_mode, status
       FROM inv_instruments WHERE id IN (${placeholders(ids.length)}) ORDER BY id`,
      ...ids,
    ).map((r) => ({
      id: int(r, "id"),
      name: text(r, "name"),
      currency: text(r, "currency"),
      assetClass: text(r, "asset_class"),
      symbol: textOrNull(r, "symbol"),
      isin: textOrNull(r, "isin"),
      mic: textOrNull(r, "mic"),
      region: textOrNull(r, "region"),
      sector: textOrNull(r, "sector"),
      tags: stringListOrNull(r, "tags") ?? [],
      needsClassification: bool(r, "needs_classification"),
      valuationMode: text(r, "valuation_mode"),
      status: text(r, "status"),
    }));
  }

  /** Aliases of the instruments `ids`, in id order. */
  aliases(ids: readonly number[]): InvAliasRow[] {
    if (ids.length === 0) return [];
    return this.query(
      `SELECT id, instrument_id, namespace, value, guessed FROM inv_instrument_aliases
       WHERE instrument_id IN (${placeholders(ids.length)}) ORDER BY id`,
      ...ids,
    ).map((r) => ({
      id: int(r, "id"),
      instrumentId: int(r, "instrument_id"),
      namespace: text(r, "namespace"),
      value: text(r, "value"),
      guessed: bool(r, "guessed"),
    }));
  }

  /** The profile's overrides of the instruments `ids`. */
  profileInstruments(profileId: number, ids: readonly number[]): InvProfileInstrumentRow[] {
    if (ids.length === 0) return [];
    return this.query(
      `SELECT instrument_id, name, asset_class, tags, region, sector, valuation_mode, status,
              needs_classification, "plan", plan_at, plan_reason, segment, segment_by
       FROM inv_profile_instruments
       WHERE profile_id = ? AND instrument_id IN (${placeholders(ids.length)}) ORDER BY id`,
      profileId,
      ...ids,
    ).map((r) => ({
      instrumentId: int(r, "instrument_id"),
      name: textOrNull(r, "name"),
      assetClass: textOrNull(r, "asset_class"),
      tags: stringListOrNull(r, "tags"),
      region: textOrNull(r, "region"),
      sector: textOrNull(r, "sector"),
      valuationMode: textOrNull(r, "valuation_mode"),
      status: textOrNull(r, "status"),
      needsClassification: boolOrNull(r, "needs_classification"),
      plan: textOrNull(r, "plan"),
      planAt: textOrNull(r, "plan_at"),
      planReason: textOrNull(r, "plan_reason"),
      segment: textOrNull(r, "segment"),
      segmentBy: textOrNull(r, "segment_by"),
    }));
  }

  /** The profile's manual valuations in `(as_of, id)` order. */
  manualValuations(profileId: number): InvManualValuationRow[] {
    return this.query(
      `SELECT id, instrument_id, as_of, unit_value, currency, note FROM inv_manual_valuations
       WHERE profile_id = ? ORDER BY as_of, id`,
      profileId,
    ).map((r) => ({
      id: int(r, "id"),
      instrumentId: int(r, "instrument_id"),
      asOf: text(r, "as_of"),
      unitValue: text(r, "unit_value"),
      currency: text(r, "currency"),
      note: textOrNull(r, "note"),
    }));
  }

  /** Every stored bar of the instruments `ids`, in `(instrument_id, date)` order. */
  priceBars(ids: readonly number[]): InvPriceBarRow[] {
    if (ids.length === 0) return [];
    return this.query(
      `SELECT instrument_id, date, close, open, high, low, volume, currency, source, fetched_at
       FROM inv_price_bars WHERE instrument_id IN (${placeholders(ids.length)})
       ORDER BY instrument_id, date`,
      ...ids,
    ).map((r) => ({
      instrumentId: int(r, "instrument_id"),
      date: text(r, "date"),
      close: text(r, "close"),
      open: textOrNull(r, "open"),
      high: textOrNull(r, "high"),
      low: textOrNull(r, "low"),
      volume: intOrNull(r, "volume"),
      currency: textOrNull(r, "currency"),
      source: text(r, "source"),
      fetchedAt: textOrNull(r, "fetched_at"),
    }));
  }

  /** Every stored FX rate, in `(base, quote, date)` order. */
  fxRates(): InvFxRateRow[] {
    return this.query(
      `SELECT base, quote, date, rate, source, fetched_at FROM inv_fx_rates
       ORDER BY base, quote, date`,
    ).map((r) => ({
      base: text(r, "base"),
      quote: text(r, "quote"),
      date: text(r, "date"),
      rate: text(r, "rate"),
      source: text(r, "source"),
      fetchedAt: textOrNull(r, "fetched_at"),
    }));
  }
}
