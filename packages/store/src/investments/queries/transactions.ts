// Brokerage accounts and what hangs off them (Python `store/transactions.py` + `convert.py`):
// transactions as domain values in chronological order, account settings, renames, manual valuations,
// broker position snapshots and import batches. The vault is the profile, so nothing filters by one.
import { D, toCurrency } from "@cashu/domain";
import {
  asAccountId,
  asImportBatchId,
  asInstrumentId,
  asTxnId,
  type InstrumentRename,
  instrumentRename,
  type ManualValuation,
  manualValuation,
  parseTxnSource,
  parseTxnType,
  type Transaction,
  transaction,
} from "@cashu/domain/investments";
import { gidOf, instrumentRoot, marks, type Read, storedTime } from "./shared.js";

/** The account type id owned by the investments module. */
export const BROKERAGE = "brokerage";

export interface BrokerageAccount {
  readonly gid: string;
  readonly bank: string;
  readonly name: string;
  readonly currency: string;
  readonly externalId: string | null;
  readonly removed: boolean;
}

const ACCOUNT_COLUMNS =
  "gid, bank, name, currency, external_id AS externalId, removed_at IS NOT NULL AS removed";

type AccountRow = Omit<BrokerageAccount, "removed"> & { removed: number };
const toAccount = (r: AccountRow): BrokerageAccount => ({ ...r, removed: r.removed === 1 });

/** Python `brokerage_accounts`: the vault's brokerage accounts, oldest first (fold order). */
export function brokerageAccounts(read: Read): BrokerageAccount[] {
  return read<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE type = ? ORDER BY id`,
    BROKERAGE,
  ).map(toAccount);
}

/** Python `brokerage_account`: one brokerage account of the vault (undefined otherwise). */
export function brokerageAccount(read: Read, gid: string): BrokerageAccount | undefined {
  const r = read<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE gid = ? AND type = ?`,
    gid,
    BROKERAGE,
  )[0];
  return r === undefined ? undefined : toAccount(r);
}

export interface AccountSettings {
  readonly account: string;
  readonly wrapper: string;
  readonly importer: string | null;
  readonly mappingYaml: string | null;
}

/** Python `account_settings`: the stored settings, else the defaults (wrapper `regular`). */
export function accountSettings(read: Read, account: string): AccountSettings {
  const r = read<{ wrapper: string; importer: string | null; mapping_yaml: string | null }>(
    `SELECT s.wrapper, s.importer, s.mapping_yaml FROM inv_account_settings s
     JOIN accounts a ON a.id = s.account_id WHERE a.gid = ?`,
    account,
  )[0];
  return {
    account,
    wrapper: r?.wrapper ?? "regular",
    importer: r?.importer ?? null,
    mappingYaml: r?.mapping_yaml ?? null,
  };
}

interface TxnRow {
  gid: string;
  account: string;
  type: string;
  trade_date: string;
  settle_date: string | null;
  instrument: string | null;
  quantity: string | null;
  price: string | null;
  currency: string;
  gross_amount: string;
  fee: string | null;
  tax: string | null;
  cash_amount: string;
  cash_currency: string;
  fx_rate: string | null;
  split_ratio: string | null;
  note: string | null;
  source: string;
  batch: string | null;
  external_ref: string | null;
  dedup_hash: string;
  created_at: string;
}

const dec = (v: string | null) => (v === null ? null : D(v));

function toTransaction(r: TxnRow): Transaction {
  return transaction({
    id: asTxnId(r.gid),
    accountId: asAccountId(r.account),
    type: parseTxnType(r.type),
    tradeDate: r.trade_date,
    settleDate: r.settle_date,
    instrumentId: r.instrument === null ? null : asInstrumentId(r.instrument),
    quantity: dec(r.quantity),
    price: dec(r.price),
    currency: toCurrency(r.currency),
    grossAmount: D(r.gross_amount),
    fee: D(r.fee ?? "0"),
    tax: D(r.tax ?? "0"),
    cashAmount: D(r.cash_amount),
    cashCurrency: toCurrency(r.cash_currency),
    fxRate: dec(r.fx_rate),
    splitRatio: dec(r.split_ratio),
    note: r.note,
    source: parseTxnSource(r.source),
    importBatchId: r.batch === null ? null : asImportBatchId(r.batch),
    externalRef: r.external_ref,
    dedupHash: r.dedup_hash,
    createdAt: storedTime(r.created_at),
  });
}

/**
 * Python `transactions`: the vault's brokerage transactions as domain values in chronological order
 * (trade date, `created_at`, fold order); `accounts` limits them to those brokerage account gids.
 */
export function transactions(read: Read, accounts?: Iterable<string>): Transaction[] {
  const only = accounts === undefined ? undefined : [...new Set(accounts)];
  if (only !== undefined && only.length === 0) return [];
  return read<TxnRow>(
    `SELECT t.gid, a.gid AS account, t.type, t.trade_date, t.settle_date,
       ${gidOf("t.instrument_id")} AS instrument, t.quantity, t.price, t.currency, t.gross_amount,
       t.fee, t.tax, t.cash_amount, t.cash_currency, t.fx_rate, t.split_ratio, t.note, t.source,
       ${gidOf("t.import_batch_id")} AS batch, t.external_ref, t.dedup_hash, t.created_at
     FROM inv_transactions t JOIN accounts a ON a.id = t.account_id
     WHERE a.type = ? ${only === undefined ? "" : `AND a.gid IN (${marks(only.length)})`}
     ORDER BY t.trade_date, t.created_at, t.id`,
    BROKERAGE,
    ...(only ?? []),
  ).map(toTransaction);
}

/** Python `existing_hashes`: the subset of `hashes` already stored for the account. */
export function existingHashes(
  read: Read,
  account: string,
  hashes: readonly string[],
): Set<string> {
  const found = new Set<string>();
  const chunk = 500; // well under SQLite's bound-parameter limit
  for (let start = 0; start < hashes.length; start += chunk) {
    const part = hashes.slice(start, start + chunk);
    for (const r of read<{ dedup_hash: string }>(
      `SELECT t.dedup_hash FROM inv_transactions t JOIN accounts a ON a.id = t.account_id
       WHERE a.gid = ? AND t.dedup_hash IN (${marks(part.length)})`,
      account,
      ...part,
    )) {
      found.add(r.dedup_hash);
    }
  }
  return found;
}

/**
 * Python `renames`: the vault's instrument renames by date (fold order on ties). A rename whose two
 * ends resolved to one instrument is not in the view (events.md 6.4).
 */
export function renames(read: Read): InstrumentRename[] {
  return read<{ date: string; old: string; new: string; note: string | null }>(
    `SELECT r.date, o.gid AS old, n.gid AS new, r.note FROM inv_instrument_renames r
     JOIN inv_instruments o ON o.id = r.old_instrument_id
     JOIN inv_instruments n ON n.id = r.new_instrument_id ORDER BY r.date, r.id`,
  ).map((r) =>
    instrumentRename({
      date: r.date,
      oldInstrumentId: asInstrumentId(r.old),
      newInstrumentId: asInstrumentId(r.new),
      note: r.note,
    }),
  );
}

/** Python `manual_valuations`: by date (fold order on ties); `instruments` limits them. */
export function manualValuations(read: Read, instruments?: Iterable<string>): ManualValuation[] {
  const only =
    instruments === undefined
      ? undefined
      : [...new Set([...instruments].map((g) => instrumentRoot(read, g)))];
  if (only !== undefined && only.length === 0) return [];
  return read<{
    instrument: string;
    as_of: string;
    unit_value: string;
    currency: string;
    note: string | null;
  }>(
    `SELECT i.gid AS instrument, v.as_of, v.unit_value, v.currency, v.note
     FROM inv_manual_valuations v JOIN inv_instruments i ON i.id = v.instrument_id
     ${only === undefined ? "" : `WHERE i.gid IN (${marks(only.length)})`}
     ORDER BY v.as_of, v.id`,
    ...(only ?? []),
  ).map((r) =>
    manualValuation({
      instrumentId: asInstrumentId(r.instrument),
      asOf: r.as_of,
      unitValue: D(r.unit_value),
      currency: toCurrency(r.currency),
      note: r.note,
    }),
  );
}

export interface PositionSnapshot {
  readonly gid: string;
  readonly instrument: string;
  readonly asOf: string;
  readonly quantity: string;
  readonly currency: string;
  readonly avgPrice: string | null;
  readonly marketValue: string | null;
  readonly batch: string | null;
}

/** Python `latest_position_snapshot`: the newest broker snapshot date of the account and its rows. */
export function latestPositionSnapshot(
  read: Read,
  account: string,
): { readonly asOf: string | null; readonly rows: readonly PositionSnapshot[] } {
  const rows = read<PositionSnapshot>(
    `SELECT p.gid, i.gid AS instrument, p.as_of AS asOf, p.quantity, p.currency,
       p.avg_price AS avgPrice, p.market_value AS marketValue, ${gidOf("p.import_batch_id")} AS batch
     FROM inv_position_snapshots p JOIN accounts a ON a.id = p.account_id
     JOIN inv_instruments i ON i.id = p.instrument_id
     WHERE a.gid = ? AND p.as_of = (
       SELECT MAX(q.as_of) FROM inv_position_snapshots q WHERE q.account_id = p.account_id)
     ORDER BY p.id`,
    account,
  );
  return { asOf: rows[0]?.asOf ?? null, rows };
}
