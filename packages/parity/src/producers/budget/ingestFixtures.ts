/// <reference types="node" />
/**
 * Producer of `budget.ingest_fixtures` (`parity/python/checks/budget_ingestion.py:ingest_fixtures`),
 * not dataset-bound: every synthetic CSV fixture of `packages/domain/test/fixtures/budget-csv` through
 * each bank parser (statement or refusal reason), then for the file's own bank three imports of its
 * rows on an empty account: plain, the same again, and with the newest-day rule.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { budget } from "@cashu/domain";
import type { OutValue } from "../output.ts";

const FIXTURES = fileURLToPath(
  new URL("../../../../domain/test/fixtures/budget-csv", import.meta.url),
);
const BANKS: readonly budget.BankId[] = ["mbank", "erste", "pekao"];

function csvFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return csvFiles(full);
    return name.endsWith(".csv") ? [full] : [];
  });
}

function statementOut(stmt: budget.ParsedStatement): OutValue {
  return {
    bank: stmt.bank,
    account_number: stmt.accountNumber,
    currency: stmt.currency,
    skipped_rows: BigInt(stmt.skippedRows),
    balances: stmt.balances.map((b) => ({ date: b.date, amount: b.amount })),
    transactions: stmt.transactions.map((t) => ({
      booking_date: t.bookingDate,
      value_date: t.valueDate,
      amount: t.amount,
      currency: t.currency,
      counterparty_name: t.counterpartyName,
      counterparty_iban: t.counterpartyIban,
      description: t.description,
      reference: t.reference,
      raw: t.raw as OutValue,
      hash_v2: budget.dedupHashV2(t),
    })),
  };
}

/** The bank a fixture belongs to (its folder; the oracle files by name); none for foreign files. */
function ownBank(rel: string): budget.BankId | null {
  const [folder = "", name = ""] = rel.split("/");
  const bank = BANKS.find((b) => b === folder);
  if (bank) return bank;
  if (folder === "oracle") return name.includes("pekao") ? "pekao" : "mbank";
  return null;
}

function roundTrip(raws: readonly budget.RawTransaction[]): OutValue {
  const stored: budget.StoredTxn[] = [];
  return [false, false, true].map((newestDayRule) => {
    const plan = budget.planImport(stored, raws, { newestDayRule });
    stored.push(...plan.toInsert);
    return {
      statuses: [...plan.statuses],
      rows: plan.toInsert.map((t) => ({ hash_v2: t.dedupHash, occurrence: BigInt(t.occurrence) })),
    };
  });
}

export function produceIngestFixtures(): OutValue {
  const files = csvFiles(FIXTURES)
    .map((full) => relative(FIXTURES, full).split("\\").join("/"))
    .sort();
  return files.map((rel) => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, rel)));
    const forced: Record<string, OutValue> = {};
    const parsed = new Map<budget.BankId, budget.ParsedStatement>();
    for (const bank of BANKS) {
      const r = budget.parseBankStatement(bytes, bank);
      if (r.ok) {
        parsed.set(bank, r.statement);
        forced[bank] = statementOut(r.statement);
      } else {
        forced[bank] = { error: r.reason };
      }
    }
    const own = ownBank(rel);
    const stmt = own === null ? undefined : parsed.get(own);
    return {
      file: rel,
      forced,
      round_trip: stmt === undefined ? null : roundTrip(stmt.transactions),
    };
  });
}
