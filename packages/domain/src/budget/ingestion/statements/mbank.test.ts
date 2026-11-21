import { describe, expect, it } from "vitest";
import { InstitutionRegistry } from "../../../core/index.js";
import { D } from "../../../decimal.js";
import { fixtureBytes } from "../testing/fixtures.js";
import type { ParsedStatement } from "../types.js";
import { detectBank, parseBankStatement, parseStatementFile } from "./registry.js";
import type { StatementResult } from "./result.js";

const registry = new InstitutionRegistry();

function statement(r: StatementResult): ParsedStatement {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.statement;
}

// tests/test_parsing.py (input: the Python constant written as cp1250 by the generator)
describe("test_parsing.py", () => {
  // test_mbank_detection_and_parse
  it("detects and parses an mBank export", () => {
    const bytes = fixtureBytes("oracle/test_parsing_mbank.csv");
    expect(detectBank(bytes, registry)).toBe("mbank");
    const stmt = statement(parseStatementFile(bytes, registry));
    expect(stmt.bank).toBe("mbank");
    expect(stmt.transactions.length).toBe(3);
    const amounts = stmt.transactions.map((t) => t.amount);
    for (const want of ["-49.99", "-12.50", "5000.00"])
      expect(amounts.some((a) => a.eq(D(want)))).toBe(true);
    expect(stmt.balances.length).toBe(3);
  });
});

// tests/test_budget_import_format.py
describe("test_budget_import_format.py", () => {
  // test_bank_parsers_count_skipped_rows
  it("counts the rows it drops, not the blank ones", () => {
    const stmt = statement(
      parseStatementFile(fixtureBytes("oracle/test_budget_import_format_skipped.csv"), registry),
    );
    expect(stmt.transactions.length).toBe(2);
    expect(stmt.skippedRows).toBe(2);
  });

  it("reads the account and currency from the preamble (origin preamble)", () => {
    const stmt = statement(
      parseStatementFile(fixtureBytes("oracle/test_budget_import_format_mbank.csv"), registry),
    );
    expect([stmt.accountNumber, stmt.accountNumberOrigin, stmt.currency]).toEqual([
      "99114000000000000000000001",
      "preamble",
      "PLN",
    ]);
  });
});

describe("kept quirks", () => {
  it("Q1: a garbage amount refuses the file with its csv record number, also in a dateless footer", () => {
    expect(parseBankStatement(fixtureBytes("mbank/mbank-garbage-amount.csv"), "mbank")).toEqual({
      ok: false,
      reason: "bad_amount",
      row: 4,
    });
    expect(parseBankStatement(fixtureBytes("mbank/mbank-footer-garbage.csv"), "mbank")).toEqual({
      ok: false,
      reason: "bad_amount",
      row: 4,
    });
  });

  it("Q3: a UTF-8 mBank file is read as cp1250 first (mojibake), as Python did", () => {
    const stmt = statement(
      parseBankStatement(fixtureBytes("mbank/mbank-utf8-diacritics.csv"), "mbank"),
    );
    expect(stmt.transactions[0]?.description).toBe("ZAKUP Ä…");
    // The header's "#Tytuł" is mojibake too, so the title column is not found at all.
    expect(stmt.transactions[0]?.reference).toBeNull();
  });

  it("Q7: the #Waluta value is taken as is", () => {
    expect(
      statement(parseBankStatement(fixtureBytes("mbank/mbank-edge.csv"), "mbank")).currency,
    ).toBe("pln");
  });

  it("refuses a file without a header row", () => {
    expect(parseBankStatement(fixtureBytes("erste/erste-single.csv"), "mbank")).toEqual({
      ok: false,
      reason: "no_header",
    });
  });
});
