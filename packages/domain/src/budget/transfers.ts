/**
 * Internal transfers between the profile's own accounts (`modules/budget/ingestion/transfers.py`).
 *
 * When money moves from one own account to another, both banks report it: an outflow on one side, an
 * inflow on the other. Matching flags such pairs so spending and income stats do not count them twice.
 * It is deliberately IBAN-only (data-safety rule 5): an outflow and an inflow of the same amount within
 * a few days pair up only when the counterparty IBAN on one leg is the other account's own IBAN. Names
 * and descriptions are never a signal, and `TransferRow` does not even carry them.
 *
 * Pure and a full recompute of its input: Python's `reset_transfer_matches` + `match_internal_transfers`
 * over the profile's rows (D-24.1). The caller passes one profile's (vault's) rows and accounts.
 */

import { daysBetween, type IsoDate } from "../dates.js";
import { DEFAULT_CONTEXT, type Decimal, format2 } from "../decimal.js";
import { ibanKey } from "../iban.js";

/** One transaction as matching sees it. */
export interface TransferRow {
  /** Row identity (store: the row gid; parity: the natural key or Python id). */
  readonly key: string;
  /** The RESOLVED account key (store: the root account gid; parity: the Python account id). Q9. */
  readonly account: string;
  readonly bookingDate: IsoDate;
  readonly amount: Decimal;
  readonly counterpartyIban: string | null;
}

/**
 * Account key -> its match key: Python `iban_key(account.iban)` of the RAW stored IBAN, "" when the
 * account has none (D-08.1: no checksum validation; every account of the profile, removed ones too).
 */
export type AccountMatchKeys = ReadonlyMap<string, string>;

/** Two row keys: the outflow leg and the inflow leg. */
export interface TransferPair {
  readonly out: string;
  readonly in: string;
}

/** `match_internal_transfers(max_days=3)`. */
export const TRANSFER_MAX_DAYS = 3;

/** The `AccountMatchKeys` of a profile's accounts (`{a.id: a for a in profile_accounts(...)}` keyed). */
export function transferAccountKeys(
  accounts: Iterable<{ readonly key: string; readonly iban: string | null }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of accounts) out.set(a.key, ibanKey(a.iban));
  return out;
}

/**
 * The amount key rows are grouped by (transfers.py:84 and 97). PARITY(Q4): an inflow formats the value
 * as given (`f"{x:.2f}"`, exact, half-even), an outflow formats `-x`, which Python first rounds to the
 * 28-digit context; the two differ only above 28 significant digits. PARITY(Q5): sub-cent amounts share
 * a key (`0.004` and `-0.001` are both "0.00") and can pair. Zero (also `-0`) is neither an inflow nor
 * an outflow and never gets a key.
 */
export function transferAmountKey(amount: Decimal): string | null {
  if (amount.isZero()) return null;
  return amount.isSigned() ? format2(amount.neg(DEFAULT_CONTEXT)) : format2(amount);
}

/**
 * transfers.py:_pair_score: 3 when the counterparty IBAN on one leg is the OTHER leg's account IBAN
 * (both as `iban_key`), else null. PARITY(Q6): the only signal; a name or amount score must never be
 * added (rule 5). An account missing from `accounts` has the key "" (it never matches).
 */
export function pairScore(
  out: TransferRow,
  inc: TransferRow,
  accounts: AccountMatchKeys,
): 3 | null {
  const outCp = ibanKey(out.counterpartyIban);
  const incCp = ibanKey(inc.counterpartyIban);
  const outAccount = accounts.get(out.account) ?? "";
  const incAccount = accounts.get(inc.account) ?? "";
  if ((outCp !== "" && outCp === incAccount) || (incCp !== "" && incCp === outAccount)) return 3;
  return null;
}

interface Best {
  readonly row: TransferRow;
  readonly score: number;
  readonly dayDiff: number;
}

/**
 * transfers.py:match_internal_transfers over the FULL given set. `rows` MUST be in anchor order
 * (Python's id order; the store's `fold_txn_keys.anchor_ord`, D-24.2): PARITY(Q2) the inflow
 * candidates of an amount key are tried in input order (SQLite returns Python's ungrouped query in
 * rowid order, pinned by the vectors' plan row). PARITY(Q3) outflows go by booking date, input order
 * breaking ties (Python's `(booking_date, id)`); the best inflow is the first strict maximum of
 * `(score, -dayDiff)`, so the nearest day wins and the earliest row among equally near ones. Pairs come
 * back in outflow processing order. Rows of different amount keys never interact.
 */
export function matchTransfers(
  rows: readonly TransferRow[],
  accounts: AccountMatchKeys,
  opts: { readonly maxDays?: number } = {},
): TransferPair[] {
  const maxDays = opts.maxDays ?? TRANSFER_MAX_DAYS;
  const inflowsByKey = new Map<string, TransferRow[]>();
  const outflows: TransferRow[] = [];
  for (const row of rows) {
    const key = transferAmountKey(row.amount);
    if (key === null) continue;
    if (row.amount.isSigned()) {
      outflows.push(row);
      continue;
    }
    const list = inflowsByKey.get(key);
    if (list === undefined) inflowsByKey.set(key, [row]);
    else list.push(row);
  }
  // Array.prototype.sort is stable: equal booking dates keep input (id) order.
  outflows.sort((a, b) =>
    a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : 0,
  );

  const matched = new Set<string>();
  const pairs: TransferPair[] = [];
  for (const out of outflows) {
    const key = transferAmountKey(out.amount);
    if (matched.has(out.key) || key === null) continue;
    let best: Best | undefined;
    for (const inc of inflowsByKey.get(key) ?? []) {
      if (matched.has(inc.key) || inc.account === out.account) continue;
      const dayDiff = Math.abs(daysBetween(out.bookingDate, inc.bookingDate));
      if (dayDiff > maxDays) continue;
      const score = pairScore(out, inc, accounts);
      if (score === null) continue;
      if (
        best === undefined ||
        score > best.score ||
        (score === best.score && dayDiff < best.dayDiff)
      ) {
        best = { row: inc, score, dayDiff };
      }
    }
    if (best !== undefined) {
      pairs.push({ out: out.key, in: best.row.key });
      matched.add(out.key);
      matched.add(best.row.key);
    }
  }
  return pairs;
}
