// Typed reads of the budget view tables the commands need (gid in, gid out).

import { D } from "@cashu/domain";
import {
  CASH_ACCOUNT_TYPE,
  type CloudMerchant,
  cloudMerchants,
  type MerchantRule,
  merchantKey,
  type ReclassifyRow,
  type RuleSource,
  type StoredTxn,
  unknownMerchants,
} from "@cashu/domain/budget";
import type { Read } from "../core/queries.js";

/**
 * Every row of the (resolved) account in storage order, cash legs, cash expenses and `legacy:` rows
 * included: they never match a v2 hash but count for the newest-day rule (S07 `StoredTxn`).
 */
export function storedTxnsOfAccount(read: Read, account: string): StoredTxn[] {
  return read<{
    dedup_hash: string;
    bank_transaction_id: string | null;
    booking_date: string;
    amount: string;
  }>(
    `SELECT t.dedup_hash, t.bank_transaction_id, t.booking_date, t.amount
     FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.gid = ? ORDER BY t.id`,
    account,
  ).map((r) => ({
    dedupHash: r.dedup_hash,
    bankTransactionId: r.bank_transaction_id,
    bookingDate: r.booking_date,
    amount: D(r.amount),
  }));
}

export interface TxnView {
  readonly gid: string;
  readonly dedupHash: string;
  readonly accountType: string | null;
  readonly currency: string;
  /** The derived `category_source` (`manual_txn` exactly when the row holds a manual claim). */
  readonly categorySource: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** The transaction row `gid` (an import's anchor, a cash expense, a cash leg). */
export function transactionByGid(read: Read, gid: string): TxnView | undefined {
  const r = read<{
    gid: string;
    dedup_hash: string;
    type: string | null;
    currency: string;
    category_source: string | null;
    raw: string;
  }>(
    `SELECT t.gid, t.dedup_hash, a.type, t.currency, t.category_source, t.raw FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id WHERE t.gid = ?`,
    gid,
  )[0];
  return r === undefined
    ? undefined
    : {
        gid: r.gid,
        dedupHash: r.dedup_hash,
        accountType: r.type,
        currency: r.currency,
        categorySource: r.category_source,
        raw: JSON.parse(r.raw),
      };
}

/**
 * The row `gid` as the transaction classifier sees it (`ReclassifyRow`: its fields, whether it is on
 * a cash account, its effective category and source), or undefined.
 */
export function reclassifyRowByGid(read: Read, gid: string): ReclassifyRow | undefined {
  const r = read<{
    gid: string;
    booking_date: string;
    currency: string;
    amount: string;
    counterparty_name: string | null;
    counterparty_iban: string | null;
    description: string | null;
    reference: string | null;
    is_internal_transfer: number;
    category: string | null;
    category_source: string | null;
    type: string | null;
  }>(
    `SELECT t.gid, t.booking_date, t.currency, t.amount, t.counterparty_name, t.counterparty_iban,
       t.description, t.reference, t.is_internal_transfer, t.category, t.category_source, a.type
     FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.gid = ?`,
    gid,
  )[0];
  return r === undefined
    ? undefined
    : {
        key: r.gid,
        bookingDate: r.booking_date,
        currency: r.currency,
        amount: D(r.amount),
        counterpartyName: r.counterparty_name,
        counterpartyIban: r.counterparty_iban,
        description: r.description,
        reference: r.reference,
        // TRANSITIONAL(S24b): always 0 until the transfers deriver writes it, so a one-sided transfer
        // leg is not structural here yet.
        isInternalTransfer: r.is_internal_transfer === 1,
        onCashAccount: r.type === CASH_ACCOUNT_TYPE,
        category: r.category,
        source: r.category_source,
      };
}

/** The merchant rule of `merchantKey` (Python `load_rules` entry), if any. */
export function ruleByMerchant(read: Read, merchantKey: string): MerchantRule | undefined {
  const r = read<{ category: string; source: string; locked: number }>(
    "SELECT category, source, locked FROM category_rules WHERE merchant_key = ?",
    merchantKey,
  )[0];
  return r === undefined
    ? undefined
    : {
        merchantKey,
        category: r.category,
        source: r.source as RuleSource,
        locked: r.locked === 1,
      };
}

/**
 * The merchants the LLM merchant pass may ask about (`categorize_all(use_llm=True)`): `local` =
 * every unknown merchant (outflows the engine left at `default`, for the on-device Ollama model);
 * `cloud` = PRIVACY(D-09.5) only what `cloudMerchants` lets through over EVERY row of the vault (a
 * merchant key ever seen with a counterparty IBAN or a person-to-person marker never goes out).
 * A cloud classifier port (S09b) accepts only `cloud`; this store sends nothing anywhere.
 */
export function classifierMerchants(read: Read): {
  readonly local: readonly string[];
  readonly cloud: readonly CloudMerchant[];
} {
  const rows = read<{
    amount: string;
    counterparty_name: string | null;
    counterparty_iban: string | null;
    description: string | null;
    reference: string | null;
    is_internal_transfer: number;
    category_source: string | null;
  }>(
    `SELECT amount, counterparty_name, counterparty_iban, description, reference,
       is_internal_transfer, category_source FROM transactions`,
  ).map((r) => ({
    amount: D(r.amount),
    counterpartyName: r.counterparty_name,
    counterpartyIban: r.counterparty_iban,
    description: r.description,
    reference: r.reference,
    isInternalTransfer: r.is_internal_transfer === 1,
    source: r.category_source,
  }));
  const cloud = cloudMerchants(rows);
  const local = unknownMerchants(
    rows.map((r) => ({
      amount: r.amount,
      merchantKey: merchantKey(r.counterpartyName, r.reference, r.description),
      source: r.source,
    })),
  );
  return { local, cloud };
}
