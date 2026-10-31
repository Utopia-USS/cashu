// Deriver budget.legs (S24 4.3, events.md 9, D-24.3): the cash mirror leg of a bank withdrawal. A
// leg row is present iff the row's claim register is the manual claim `cash_withdrawal`, the row is
// not on a cash account, and the cash pool account of its currency (`DET(accounts)["ext", "manual",
// "cash:<CUR>"]`) is open. Python `cash.sync_cash_leg`: a positive entry on the pool, gid
// `DET(transactions)["cashleg", anchor]`, `dedup_hash = "cashleg:" + anchor`, `raw.cash_leg_of =
// anchor`; its category is the leg claim when one is held, else `cash_withdrawal` / `cash_leg`.
// The deriver owns these rows (`dedup_hash LIKE 'cashleg:%'`); `fold_txn_legs` remembers which leg
// a partition produced, so a vanished source or a moved anchor drops the old leg.
import { ACCOUNTS } from "../../core/accounts.js";
import type { DeriveContext, Deriver } from "../../engine/types.js";
import type { TableDef } from "../../sql/ddl.js";
import { sqlJson } from "../../sql/values.js";
import { CASHLEG, legClaimed, splitKey, TRANSACTIONS } from "../transactions.js";
import { selectIn } from "./keys.js";

/** Polish matching data written by Python `budget/cash.py` (byte-identical, hash-tested). */
export const CASH_WITHDRAWAL_TEXT = "Wypłata gotówki";

const legsTable: TableDef = {
  name: "fold_txn_legs",
  primaryKey: ["partition"],
  internal: true,
  withoutRowid: true,
  columns: [
    { name: "partition", type: "TEXT", notNull: true },
    { name: "leg_gid", type: "TEXT", notNull: true },
  ],
};

interface Source {
  gid: string;
  booking_date: string;
  value_date: string | null;
  amount: string;
  currency: string;
  description: string | null;
  reference: string | null;
  created_at: string;
  account_type: string | null;
}

interface ClaimRow {
  partition: string;
  claim: string | null;
  claim_by: string | null;
  leg_claim: string | null;
  leg_claim_by: string | null;
  leg_on: string | null;
}

interface Leg {
  gid: string;
  values: (string | number | null)[];
}

/** The cash pool account of `currency` in this vault (its resolved gid). */
function poolAccountId(ctx: DeriveContext, currency: string): number | undefined {
  const pool = ctx.resolve(ACCOUNTS, ctx.det("accounts", ["ext", "manual", `cash:${currency}`]));
  return ctx.sql.get<{ id: number }>("SELECT id FROM accounts WHERE gid = ?", pool)?.id;
}

function computeLeg(ctx: DeriveContext, key: string, c: ClaimRow | undefined): Leg | undefined {
  if (c === undefined || !legClaimed(c) || !key.includes("|")) return undefined;
  const [root, hash, occurrence] = splitKey(key);
  const src = ctx.sql.get<Source>(
    `SELECT t.gid, t.booking_date, t.value_date, t.amount, t.currency, t.description, t.reference,
       t.created_at, a.type AS account_type
     FROM transactions t JOIN view_ids v ON v.id = t.account_id
       LEFT JOIN accounts a ON a.id = t.account_id
     WHERE v.gid = ? AND t.dedup_hash = ? AND t.occurrence = ?`,
    root,
    hash,
    occurrence,
  );
  if (src === undefined || src.account_type === "cash") return undefined;
  const poolId = poolAccountId(ctx, src.currency);
  if (poolId === undefined) return undefined;
  const gid = ctx.det("transactions", ["cashleg", src.gid]);
  const claimed = c.leg_claim !== null;
  return {
    gid,
    values: [
      ctx.id(gid),
      gid,
      poolId,
      src.booking_date,
      src.value_date,
      src.amount.replace(/^-/, ""),
      src.currency,
      CASH_WITHDRAWAL_TEXT,
      // Python `bank_txn.reference or bank_txn.description or "Wypłata gotówki"` (empty is falsy)
      src.reference || src.description || CASH_WITHDRAWAL_TEXT,
      CASH_WITHDRAWAL_TEXT,
      CASHLEG + src.gid,
      claimed ? c.leg_claim : "cash_withdrawal",
      claimed ? c.leg_claim_by : "cash_leg",
      sqlJson({ cash_leg_of: src.gid }),
      c.leg_on ?? src.created_at,
    ],
  };
}

function writeLeg(ctx: DeriveContext, key: string, leg: Leg | undefined, prev: string | undefined) {
  if (prev !== undefined && prev !== leg?.gid) {
    ctx.sql.write(TRANSACTIONS, "DELETE FROM transactions WHERE gid = ?", prev);
    ctx.sql.write(legsTable.name, "DELETE FROM fold_txn_legs WHERE partition = ?", key);
  }
  if (leg === undefined) return;
  ctx.sql.write(
    TRANSACTIONS,
    `INSERT INTO transactions (id, gid, account_id, booking_date, value_date, amount, currency,
       counterparty_name, counterparty_iban, description, reference, bank_transaction_id, source,
       dedup_hash, occurrence, category, category_source, raw, import_batch_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, 'manual', ?, 0, ?, ?, ?, NULL, ?)
     ON CONFLICT (gid) DO UPDATE SET account_id = excluded.account_id,
       booking_date = excluded.booking_date, value_date = excluded.value_date,
       amount = excluded.amount, currency = excluded.currency, description = excluded.description,
       category = excluded.category, category_source = excluded.category_source,
       raw = excluded.raw, created_at = excluded.created_at
     WHERE transactions.account_id IS NOT excluded.account_id
       OR transactions.booking_date IS NOT excluded.booking_date
       OR transactions.value_date IS NOT excluded.value_date
       OR transactions.amount IS NOT excluded.amount OR transactions.currency IS NOT excluded.currency
       OR transactions.description IS NOT excluded.description
       OR transactions.category IS NOT excluded.category
       OR transactions.category_source IS NOT excluded.category_source
       OR transactions.raw IS NOT excluded.raw OR transactions.created_at IS NOT excluded.created_at`,
    ...leg.values,
  );
  if (prev !== leg.gid) {
    ctx.sql.write(
      legsTable.name,
      "INSERT OR REPLACE INTO fold_txn_legs (partition, leg_gid) VALUES (?, ?)",
      key,
      leg.gid,
    );
  }
}

/** Re-derive the legs of `keys` (partitions whose leg may have changed). */
function deriveKeys(ctx: DeriveContext, keys: readonly string[]): void {
  const claims = new Map(
    selectIn<ClaimRow>(
      ctx.sql,
      "SELECT * FROM fold_transaction_claims WHERE partition IN (%IN%)",
      keys,
    ).map((c) => [c.partition, c]),
  );
  const prev = new Map(
    selectIn<{ partition: string; leg_gid: string }>(
      ctx.sql,
      "SELECT partition, leg_gid FROM fold_txn_legs WHERE partition IN (%IN%)",
      keys,
    ).map((r) => [r.partition, r.leg_gid]),
  );
  for (const key of keys) {
    const c = claims.get(key);
    const was = prev.get(key);
    if (was === undefined && (c === undefined || !legClaimed(c))) continue;
    writeLeg(ctx, key, computeLeg(ctx, key, c), was);
  }
}

export const legsDeriver: Deriver = {
  id: "budget.legs",
  version: 1,
  tables: [legsTable],
  writes: [{ table: TRANSACTIONS, rows: `dedup_hash LIKE '${CASHLEG}%'` }],
  inputs: ["budget.transactions", "core.accounts"],
  derive(dirty, ctx) {
    // An account change can open the pool or change a row's account type: every leg is re-checked
    // (legs are few: one per manual cash withdrawal claim).
    if (dirty.has("core.accounts")) {
      this.deriveAll(ctx);
      return;
    }
    const p = dirty.get("budget.transactions");
    if (p !== undefined && p !== "all") deriveKeys(ctx, [...p]);
  },
  deriveAll(ctx) {
    const keys = new Set(
      ctx.sql
        .all<{ partition: string }>(
          `SELECT partition FROM fold_transaction_claims
           WHERE claim = 'cash_withdrawal' AND claim_by = 'manual_txn'
           UNION SELECT partition FROM fold_txn_legs`,
        )
        .map((r) => r.partition),
    );
    deriveKeys(ctx, [...keys]);
    // A full re-fold of the transactions truncated the table: legs whose key no longer produces
    // one are gone with it, so only the remembered keys above can hold a stale leg.
  },
};
