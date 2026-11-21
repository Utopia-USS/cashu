/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadVectors, Mismatches } from "../../../testing/vectors.js";
import { contentKeyV2, dedupHashV2 } from "../contentKey.js";
import { fixtureBytes } from "../testing/fixtures.js";
import type { ParsedStatement } from "../types.js";
import { parseDelimited } from "./delimited.js";
import { parseBankStatement } from "./registry.js";
import { type BankId, refusing, type StatementResult } from "./result.js";

/** Python exception class -> the TS refusal reason it maps to. */
const PY_ERROR: Record<string, string> = {
  ValueError: "no_header",
  InvalidOperation: "bad_amount",
  UnicodeDecodeError: "undecodable",
  Error: "bad_csv",
};

/** The statement in the generator's `statement_json` shape (v1 with account id 1 via node:crypto). */
function statementJson(stmt: ParsedStatement): unknown {
  return {
    bank: stmt.bank,
    account_number: stmt.accountNumber,
    account_name: stmt.accountName,
    currency: stmt.currency,
    skipped_rows: stmt.skippedRows,
    balances: stmt.balances.map((b) => [b.date, b.amount.toString()]),
    closing_balances: stmt.closingBalances.map((b) => [b.date, b.amount.toString()]),
    transactions: stmt.transactions.map((t) => ({
      booking_date: t.bookingDate,
      value_date: t.valueDate,
      amount: t.amount.toString(),
      currency: t.currency,
      counterparty_name: t.counterpartyName,
      counterparty_iban: t.counterpartyIban,
      description: t.description,
      reference: t.reference,
      bank_transaction_id: t.bankTransactionId,
      source: t.source,
      raw: t.raw,
      v2: dedupHashV2(t),
      v1: createHash("sha1")
        .update(`1|${contentKeyV2(t)}`, "utf8")
        .digest("hex"),
    })),
  };
}

function outcome(r: StatementResult): unknown {
  return r.ok ? statementJson(r.statement) : { error: r.reason };
}

function pythonOutcome(want: unknown): unknown {
  const error = (want as { error?: string }).error;
  return error === undefined ? want : { error: PY_ERROR[error] ?? error };
}

/** The generator's debit / credit importer (`DebitCreditImporter`), mirrored as a test-local config. */
const debitCredit = (bytes: Uint8Array) =>
  refusing(() =>
    parseDelimited(bytes, {
      bank: "test_dc",
      encodings: ["utf-8-sig", "cp1250", "iso-8859-2", "utf-8"],
      delimiters: [";", ",", "\t"],
      colmap: {
        booking_date: ["data"],
        value_date: [],
        amount: [],
        counterparty: [],
        description: [],
        title: [],
        counterparty_iban: [],
        currency: [],
        balance: [],
        debit: ["obciazenia"],
        credit: ["uznania"],
      },
    }),
  );

const files = loadVectors("budget-statements").rows as [
  string,
  string,
  Record<BankId, unknown>,
  string | null,
  unknown,
][];

describe("statement vectors: every fixture through every bank parser (vectors_budget.py)", () => {
  it("statements (rows, raw cells, balances, skipped rows, account, v1 / v2 hashes) equal Python", () => {
    const m = new Mismatches();
    for (const [, rel, forced] of files) {
      const bytes = fixtureBytes(rel);
      for (const bank of ["mbank", "erste", "pekao"] as const) {
        m.check(
          `${rel} ${bank}`,
          outcome(parseBankStatement(bytes, bank)),
          pythonOutcome(forced[bank]),
        );
      }
    }
    expect(m.items, m.report()).toEqual([]);
    expect(m.checked).toBe(files.length * 3);
  });

  it("the engine's debit / credit branch equals Python's", () => {
    const [, rel, , , engine] = files.find((f) => f[1] === "engine/debit-credit.csv") ?? [];
    expect(rel).toBeDefined();
    expect(outcome(debitCredit(fixtureBytes(rel as string)))).toEqual(engine);
  });
});
