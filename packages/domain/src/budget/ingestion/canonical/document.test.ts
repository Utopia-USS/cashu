/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InstitutionRegistry } from "../../../core/index.js";
import { D } from "../../../decimal.js";
import { loadVectors } from "../../../testing/vectors.js";
import { planImport } from "../dedup.js";
import { parseBankStatement } from "../statements/registry.js";
import { canonicalOut } from "../testing/canonicalOut.js";
import { fixtureBytes, REPO_ROOT } from "../testing/fixtures.js";
import type { ParsedStatement } from "../types.js";
import {
  ACCOUNT_FIELDS,
  BALANCE_FIELDS,
  CSV_COLUMNS,
  MAX_ACCOUNT_NAME,
  MAX_ID,
  MAX_TEXT,
  REQUIRED_CSV_COLUMNS,
  THREE_DECIMAL_CURRENCIES,
  TOP_LEVEL_KEYS,
  TRANSACTION_FIELDS,
} from "./constants.js";
import {
  looksLikeBudgetDocument,
  parseBudgetDocument,
  reportAsDict,
  reportSummary,
  validateBudgetDocument,
} from "./document.js";
import { type BudgetIssue, budgetIssue, issueAsDict, issueCode } from "./issues.js";
import { canonicalOk } from "./validate.js";

const registry = new InstitutionRegistry();
const IBAN = "PL99114000000000000000000001";
const SECRET = "ZZSENTINELZZ";
const enc = (s: string) => new TextEncoder().encode(s);

/** tests/test_budget_import_format.py `doc()`. */
function doc(): Record<string, unknown> {
  return {
    format: "cashu-budget-import",
    format_version: 1,
    source: "test_api",
    account: { iban: IBAN, name: "Konto Test", currency: "PLN" },
    balances: [{ date: "2026-10-05", amount: "1234.56" }],
    transactions: [
      {
        booking_date: "2026-10-04",
        amount: "-42.10",
        currency: "PLN",
        counterparty_name: "SKLEP TEST",
        description: "ZAKUP PRZY UZYCIU KARTY",
        reference: "SKLEP TEST WARSZAWA",
        transaction_id: "T1",
        balance_after: "1234.56",
      },
      { booking_date: "2026-10-03", amount: 9000, currency: "pln", reference: "WYPLATA" },
    ],
  };
}
const asJson = (d: unknown) => enc(JSON.stringify(d));
const parse = (content: Uint8Array, name = "x.json", source: "csv" | "connector" = "csv") =>
  parseBudgetDocument(content, name, { registry, source });
const keys = (issues: readonly BudgetIssue[]) => issues.map((i) => [i.kind, i.row, i.field]);
const statement = (s: ParsedStatement | null): ParsedStatement => {
  if (s === null) throw new Error("no statement");
  return s;
};

// tests/test_budget_import_format.py (the parametrized tables are covered row for row by the vectors too)
describe("test_budget_import_format.py", () => {
  // test_valid_json_maps_to_raw_transactions
  it("maps a valid JSON document to raw transactions", () => {
    const r = parse(asJson(doc()));
    expect([canonicalOk(r), r.variant, r.source]).toEqual([true, "json", "test_api"]);
    const stmt = statement(r.statement);
    expect([stmt.bank, stmt.accountNumber, stmt.accountName, stmt.currency]).toEqual([
      "test_api",
      IBAN,
      "Konto Test",
      "PLN",
    ]);
    const [t0, t1] = stmt.transactions;
    expect([t0?.bookingDate, t0?.amount.toString(), t0?.bankTransactionId, t0?.source]).toEqual([
      "2026-10-04",
      "-42.10",
      "T1",
      "csv",
    ]);
    expect([t1?.amount.eq(D("9000")), t1?.currency]).toEqual([true, "PLN"]);
    expect(stmt.balances.map((b) => [b.date, b.amount.toString()])).toEqual([
      ["2026-10-04", "1234.56"],
    ]);
    expect(stmt.closingBalances.map((b) => [b.date, b.amount.toString()])).toEqual([
      ["2026-10-05", "1234.56"],
    ]);
    expect(r.issues).toEqual([]);
  });

  // test_institution_names_the_bank_and_an_unknown_one_is_a_warning
  it("takes the bank from the institution; an unknown one is a warning", () => {
    const d = doc();
    (d.account as Record<string, unknown>).institution = "mbank";
    expect(parse(asJson(d)).statement?.bank).toBe("mbank");
    (d.account as Record<string, unknown>).institution = "nowybank";
    const r = parse(asJson(d));
    expect([canonicalOk(r), r.statement?.bank]).toEqual([true, "nowybank"]);
    expect(r.issues.map((i) => [i.kind, i.blocking])).toEqual([["unknown_institution", false]]);
  });

  // test_connector_source_marks_the_rows
  it("marks the rows with the given source", () => {
    expect(
      statement(parse(asJson(doc()), "x.json", "connector").statement).transactions.map(
        (t) => t.source,
      ),
    ).toEqual(["connector", "connector"]);
  });

  // test_broken_json_is_a_file_format_issue
  it("reports broken JSON as one file_format issue", () => {
    for (const content of ["{", "[1, 2]", '{"a": 1, "a": 2}', '{"x": NaN}']) {
      expect(parse(enc(content)).issues.map((i) => i.kind)).toEqual(["file_format"]);
    }
    expect(parse(Uint8Array.of(0xff, 0xfe)).issues.map((i) => i.kind)).toEqual(["file_format"]);
  });

  // test_messages_never_carry_values
  it("never puts a value into an issue", () => {
    const d = doc();
    const txns = d.transactions as Record<string, unknown>[];
    Object.assign(txns[1] as object, {
      amount: SECRET,
      booking_date: SECRET,
      currency: SECRET,
      counterparty_iban: `${SECRET}!`,
      description: SECRET.repeat(60),
    });
    (d.account as Record<string, unknown>).iban = SECRET.slice(0, 3);
    d[`${SECRET.toLowerCase()}x`] = 1;
    const r = parse(asJson(d));
    expect(r.issues.length).toBeGreaterThanOrEqual(5);
    expect(
      JSON.stringify(r.issues.map(issueAsDict)).replace(`${SECRET.toLowerCase()}x`, ""),
    ).not.toContain(SECRET);
    const csv = `format_version,booking_date,amount,currency,description\n1,${SECRET},${SECRET},${SECRET},${SECRET.repeat(60)}\n`;
    const c = parse(enc(csv), "x.csv");
    expect(c.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(c.issues.map(issueAsDict))).not.toContain(SECRET);
  });

  // test_csv_variant
  it("reads the CSV variant", () => {
    const csv =
      "format_version,booking_date,amount,currency,counterparty_name,reference,transaction_id,account_iban,account_currency,source\n" +
      `1,2026-10-01,-10.00,PLN,KAWIARNIA TEST,KAWA,C1,${IBAN},PLN,my_conv\n\n` +
      `1,2026-10-02,25.50,PLN,,ZWROT,C2,${IBAN},PLN,my_conv\n`;
    const r = parse(enc(`﻿${csv}`), "x.csv");
    expect([canonicalOk(r), r.variant, r.source]).toEqual([true, "csv", "my_conv"]);
    const stmt = statement(r.statement);
    expect([stmt.accountNumber, stmt.currency, stmt.bank]).toEqual([IBAN, "PLN", "my_conv"]);
    expect(stmt.transactions.map((t) => [t.amount.toString(), t.bankTransactionId])).toEqual([
      ["-10.00", "C1"],
      ["25.50", "C2"],
    ]);
  });

  // test_csv_account_currency_is_inferred_from_one_row_currency
  it("infers the account currency from a single row currency", () => {
    const content = "format_version,booking_date,amount,currency\n1,2026-10-01,-1.00,EUR\n";
    expect(parse(enc(content), "x.csv").statement?.currency).toBe("EUR");
    const mixed = parse(enc(`${content}1,2026-10-02,-1.00,PLN\n`), "x.csv");
    expect(keys(mixed.issues)).toContainEqual(["missing_column", null, "account_currency"]);
  });

  // test_detection
  it("detects budget documents", () => {
    expect(looksLikeBudgetDocument(asJson(doc()), "statement.json")).toBe(true);
    expect(looksLikeBudgetDocument(asJson(doc()), "noext")).toBe(true);
    expect(looksLikeBudgetDocument(enc("format_version,booking_date,amount\n"), "x.csv")).toBe(
      true,
    );
    expect(looksLikeBudgetDocument(enc('{"format": "cashu-import"}'), "x.json")).toBe(false);
    expect(looksLikeBudgetDocument(enc("#Data operacji;#Kwota\n"), "mbank.csv")).toBe(false);
    expect(looksLikeBudgetDocument(Uint8Array.of(0, 1, 2), "x.bin")).toBe(false);
  });

  // test_validation_report_is_value_free_and_counts
  it("reports counts, dates and currencies without values", () => {
    const report = validateBudgetDocument(asJson(doc()), "x.json", registry);
    const out = reportAsDict(report);
    expect([report.ok, report.transactionCount, report.closingCount]).toEqual([true, 2, 1]);
    expect([out.date_range, out.currencies, out.issues, out.variant]).toEqual([
      { from: "2026-10-03", to: "2026-10-04" },
      ["PLN"],
      [],
      "json",
    ]);
    const bad = doc();
    ((bad.transactions as Record<string, unknown>[])[0] as Record<string, unknown>).amount = "abc";
    const badReport = validateBudgetDocument(asJson(bad), "x.json", registry);
    expect([badReport.ok, badReport.transactionCount]).toEqual([false, 2]);
    expect(reportAsDict(badReport).issue_counts).toEqual({ invalid_value: 1 });
    expect(reportSummary(badReport)).toContain("row 1: amount:");
    expect(reportSummary(badReport)).not.toContain("abc");
  });

  // test_issue_shape
  it("has the issue shape of as_dict()", () => {
    const issue = budgetIssue("invalid_value", "is required", 3, "amount");
    expect(issueCode(issue)).toBe("import.invalid_value");
    expect(issueAsDict(issue)).toEqual({
      kind: "invalid_value",
      code: "import.invalid_value",
      row: 3,
      field: "amount",
      message: "is required",
      blocking: true,
    });
  });

  // test_connector_rows_round_trip_and_dedup_against_csv_rows (pure part; the account match is S24)
  it("a connector document deduplicates against the same rows imported from the bank CSV", () => {
    const csv = parseBankStatement(
      fixtureBytes("oracle/test_budget_import_format_mbank.csv"),
      "mbank",
    );
    if (!csv.ok) throw new Error(csv.reason);
    const first = planImport([], csv.statement.transactions);
    expect(first.toInsert.length).toBe(2);
    const d = {
      format: "cashu-budget-import",
      format_version: 1,
      source: "mbank_api",
      account: { iban: IBAN, currency: "PLN" },
      transactions: [
        {
          booking_date: "2026-10-01",
          amount: "-12.50",
          currency: "PLN",
          counterparty_name: "KAWIARNIA TEST",
          description: "ZAKUP PRZY UZYCIU KARTY",
          reference: "KAWIARNIA TEST",
          transaction_id: "X1",
        },
        {
          booking_date: "2026-10-02",
          amount: "100.00",
          currency: "PLN",
          counterparty_name: "JAN TEST",
          counterparty_iban: "99109000000000000000000003",
          description: "PRZELEW PRZYCHODZACY",
          reference: "ZWROT",
        },
        { booking_date: "2026-10-03", amount: "-5.00", currency: "PLN", reference: "NOWY" },
      ],
      balances: [{ date: "2026-10-03", amount: "1082.50" }],
    };
    const stmt = statement(parse(asJson(d), "x.json", "connector").statement);
    const plan = planImport(first.toInsert, stmt.transactions, { newestDayRule: true });
    expect([plan.toInsert.length, plan.numDuplicates]).toEqual([1, 2]);
    expect(plan.toInsert[0]?.source).toBe("connector");
  });
});

describe("the documented format (docs/budget-import-format.md, docs/schemas)", () => {
  const rows = loadVectors("budget-canonical-docs").rows;

  // test_the_documented_full_examples_validate (Python's outcome of each example, then the TS one)
  it("the documented full examples give Python's outcome", () => {
    const examples = rows.filter((r) => r[0] === "example");
    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const [, lang, block, want] of examples as [string, string, string, unknown][]) {
      expect(
        canonicalOut(enc(block), lang === "json" ? "example.json" : "example.csv", "csv"),
      ).toEqual(want);
    }
    const doc = readFileSync(join(REPO_ROOT, "docs", "budget-import-format.md"), "utf8");
    for (const [, , block] of examples as [string, string, string][]) expect(doc).toContain(block);
  });

  // test_the_documented_field_lists_match_the_model
  it("the field lists equal the model's and the doc names every field", () => {
    const [, txn, account, top, csv, required, three] = rows[0] as [string, ...string[][]];
    expect([
      TRANSACTION_FIELDS,
      ACCOUNT_FIELDS,
      TOP_LEVEL_KEYS,
      CSV_COLUMNS,
      REQUIRED_CSV_COLUMNS,
    ]).toEqual([txn, account, top, csv, required]);
    expect([...THREE_DECIMAL_CURRENCIES].sort()).toEqual(three);
    const doc = readFileSync(join(REPO_ROOT, "docs", "budget-import-format.md"), "utf8");
    for (const f of [...TRANSACTION_FIELDS, ...ACCOUNT_FIELDS, ...TOP_LEVEL_KEYS, ...CSV_COLUMNS])
      expect(doc).toContain(`\`${f}\``);
  });

  it("the JSON schema lists the same fields, orders and limits", () => {
    const schema = JSON.parse(
      readFileSync(join(REPO_ROOT, "docs", "schemas", "cashu-budget-import.v1.json"), "utf8"),
    );
    const props = (def: string) => Object.keys(schema.$defs[def].properties);
    expect(Object.keys(schema.properties)).toEqual([...TOP_LEVEL_KEYS]);
    expect(props("DocTransaction")).toEqual([...TRANSACTION_FIELDS]);
    expect(props("DocAccount")).toEqual([...ACCOUNT_FIELDS]);
    expect(props("DocBalance")).toEqual([...BALANCE_FIELDS]);
    const max = (def: string, f: string) => schema.$defs[def].properties[f].anyOf[0].maxLength;
    expect([
      max("DocTransaction", "description"),
      max("DocTransaction", "reference"),
      max("DocAccount", "name"),
    ]).toEqual([MAX_TEXT, MAX_ID, MAX_ACCOUNT_NAME]);
  });
});
