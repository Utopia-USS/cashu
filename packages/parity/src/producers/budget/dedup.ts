/// <reference types="node" />
/**
 * Producer of `budget.dedup` (`parity/python/checks/budget_ingestion.py:dedup`): per profile with the
 * budget module, per account, every stored content row (40-hex `dedup_hash`) in id order with its v2
 * hash recomputed from the stored columns, the occurrence the TS dedup assigns, and whether the stored
 * Python v1 hash equals `sha1(account_id|content key)`; plus the count of non-content rows.
 *
 * The occurrence is `planImport` over the account's content rows in id order from an empty state:
 * each row is numbered by its earlier same-hash rows, Python's numbering when no row was deleted.
 * v1 needs the Python integer account id, so it is computed here (node:crypto), never in the domain.
 */

import { createHash } from "node:crypto";
import { budget, D } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";

const HEX40 = /^[0-9a-f]{40}$/;

type Row = ReturnType<PythonDb["transactions"]>[number];

function rawOf(row: Row): budget.RawTransaction {
  return {
    bookingDate: row.bookingDate,
    valueDate: row.valueDate,
    amount: D(row.amount),
    currency: row.currency,
    counterpartyName: row.counterpartyName,
    counterpartyIban: row.counterpartyIban,
    description: row.description,
    reference: row.reference,
    bankTransactionId: null,
    source: row.source as budget.TxnSource,
    raw: {},
  };
}

function accountOut(accountId: number, rows: readonly Row[]): OutValue {
  const content = rows.filter((r) => HEX40.test(r.dedupHash));
  const raws = content.map(rawOf);
  const plan = budget.planImport([], raws);
  return {
    rows: content.map((row, i) => {
      const raw = raws[i] as budget.RawTransaction;
      const key = budget.contentKeyV2(raw);
      const v1 = createHash("sha1").update(`${accountId}|${key}`, "utf8").digest("hex");
      return {
        booking_date: row.bookingDate,
        hash_v2: budget.dedupHashV2(raw),
        occurrence: BigInt(plan.toInsert[i]?.occurrence ?? -1),
        v1_ok: v1 === row.dedupHash,
      };
    }),
    non_content_rows: BigInt(rows.length - content.length),
  };
}

export function produceBudgetDedup(db: PythonDb): OutValue {
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) {
    if (!db.enabledModules(p.id).includes("budget")) continue;
    const byAccount = new Map<number, Row[]>();
    for (const row of db.transactions(p.id)) {
      const list = byAccount.get(row.accountId) ?? [];
      list.push(row);
      byAccount.set(row.accountId, list);
    }
    const accounts: Record<string, OutValue> = {};
    for (const [accountId, rows] of byAccount)
      accounts[db.keys.key("accounts", accountId)] = accountOut(accountId, rows);
    out[db.keys.key("profiles", p.id)] = accounts;
  }
  return out;
}
