import { describe, expect, it } from "vitest";
import { Currencies, TXN_TYPES, TxnType } from "../domain/index.js";
import {
  CANONICAL_BROKER_ID,
  CanonicalImporter,
  CSV_COLUMNS,
  parseCanonicalCsv,
  parseCanonicalJson,
  RECORD_FIELDS,
} from "./canonical/index.js";
import {
  type ImportParseResult,
  ImportWarningKind,
  type ParsedDelisting,
  type ParsedRename,
  type ParsedTxn,
} from "./contract.js";
import { day, enc, sameDecimal, specBlocks, specText } from "./testing/support.js";

// Translation of tests/investments/importing/test_imp_canonical.py (the Python test name is in a
// comment above each test).
const HEADER =
  "format_version,record,date,time,type,external_ref,symbol,isin,exchange,quantity,price,currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,note";

const spec = (language: string, needle: string) =>
  specBlocks(language).find((block) => block.includes(needle)) as string;
const csvExample = () => spec("csv", "position");
const jsonExample = () => spec("json", '"records": [\n');

function csvRows(rows: readonly string[], header = HEADER): ImportParseResult {
  return parseCanonicalCsv(enc(`${[header, ...rows].join("\n")}\n`));
}

/** One CSV row for HEADER (unset columns empty, format_version 1, record txn). */
function txnRow(fields: Record<string, string>): string {
  const values: Record<string, string> = { format_version: "1", record: "txn", ...fields };
  return HEADER.split(",")
    .map((column) => values[column] ?? "")
    .join(",");
}

function fullRow(fields: Record<string, string>): string {
  const values: Record<string, string> = { format_version: "1", ...fields };
  return CSV_COLUMNS.map((column) => values[column] ?? "").join(",");
}

function jsonDoc(records: readonly string[], top = ""): ImportParseResult {
  const body = records.join(",\n");
  const extra = top ? `${top},` : "";
  return parseCanonicalJson(
    enc(`{"format": "cashu-import", "format_version": 1, ${extra} "records": [${body}]}`),
  );
}

const byRow = (result: ImportParseResult) =>
  new Map(result.warnings.filter((w) => w.row !== null).map((w) => [w.row as number, w]));

/** `strip(result)`: transactions without their raw rows, decimals by value. */
const comparable = (result: ImportParseResult) =>
  result.txns.map((t) => ({
    ...t,
    rawRow: undefined,
    grossAmount: t.grossAmount.toString(),
    cashAmount: t.cashAmount.toString(),
    quantity: t.quantity?.toString() ?? null,
    price: t.price?.toString() ?? null,
    fee: t.fee.toString(),
    tax: t.tax.toString(),
    fxRate: t.fxRate?.toString() ?? null,
    splitRatio: t.splitRatio?.toString() ?? null,
  }));

const normalizedPositions = (result: ImportParseResult) =>
  result.positions.map((p) => ({
    ...p,
    quantity: p.quantity.toString(),
    avgPrice: p.avgPrice?.toString() ?? null,
    marketValue: p.marketValue?.toString() ?? null,
  }));

// --- the spec ---------------------------------------------------------------------------------

describe("the spec (docs/import-format.md)", () => {
  // test_every_csv_example_in_the_spec_validates
  it("every CSV example in the spec validates", () => {
    const blocks = specBlocks("csv").filter((b) => b.startsWith("format_version"));
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks)
      expect(parseCanonicalCsv(enc(block)).warnings, block.slice(0, 80)).toEqual([]);
  });

  // test_every_json_example_in_the_spec_validates
  it("every JSON example in the spec validates", () => {
    const blocks = specBlocks("json").filter((b) => b.includes('"records": [\n'));
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(parseCanonicalJson(enc(block)).warnings).toEqual([]);
  });

  // test_spec_csv_and_json_examples_carry_the_same_data
  it("spec CSV and JSON examples carry the same data", () => {
    const csv = parseCanonicalCsv(enc(csvExample()));
    const json = parseCanonicalJson(enc(jsonExample()));
    expect(comparable(csv)).toEqual(comparable(json));
    expect(normalizedPositions(csv)).toEqual(normalizedPositions(json));
    expect(csv.corporateActions).toEqual(json.corporateActions);
    expect([csv.source, csv.accountHint]).toEqual(["examplebroker", "Account 12-3456"]);
    expect([json.source, json.accountHint]).toEqual(["examplebroker", "Account 12-3456"]);
    expect([csv.txns.length, csv.positions.length]).toEqual([11, 3]);
  });

  // test_spec_documents_every_column
  it("spec documents every column", () => {
    const text = specText();
    for (const column of CSV_COLUMNS) expect(text, column).toContain(`\`${column}\``);
    for (const kind of TXN_TYPES) expect(text, kind).toContain(`\`${kind}\``);
    expect(text, "the em dash character is not used").not.toContain(String.fromCodePoint(0x2014));
  });

  // test_spec_example_values
  it("spec example values", () => {
    const result = parseCanonicalCsv(enc(csvExample()));
    const derived = result.txns.find((t) => t.externalRef === "T-1004") as ParsedTxn;
    expect(
      sameDecimal(derived.cashAmount, "-4004") &&
        derived.cashCurrency === Currencies.PLN &&
        sameDecimal(derived.grossAmount, "1000"),
    ).toBe(true);
    expect(derived.tradeTime).toEqual({ hour: 16, minute: 0, second: 0 });
    const split = result.txns.find((t) => t.type === TxnType.SPLIT) as ParsedTxn;
    expect(sameDecimal(split.splitRatio, "4") && split.cashAmount.isZero()).toBe(true);
    const [rename, delisting] = result.corporateActions as [ParsedRename, ParsedDelisting];
    expect([rename.kind, delisting.kind]).toEqual(["rename", "delisting"]);
    expect([rename.oldSymbol, rename.newSymbol, rename.newIsin]).toEqual([
      "ABC",
      "ABCN",
      "PLABCN000012",
    ]);
    expect([rename.date, rename.rowIndex]).toEqual([day("2026-02-15"), 11]);
    expect([delisting.frozen, delisting.symbol]).toEqual([true, "ZZZ"]);
    expect(new Set(result.positions.map((p) => p.asOf))).toEqual(new Set([day("2026-02-28")]));
  });
});

// --- detection --------------------------------------------------------------------------------

describe("detection", () => {
  const file = (name: string, text: string) => ({ name, content: enc(text) });

  // test_can_parse
  it("can parse", () => {
    const importer = new CanonicalImporter();
    expect(importer.canParse(file("x.csv", `${HEADER}\n`))).toBe(true);
    expect(importer.canParse(file("x.CSV", `﻿${HEADER}\n`))).toBe(true);
    expect(importer.canParse(file("x.txt", "record,format_version,date\n"))).toBe(true);
    expect(importer.canParse(file("x.csv", "date,type,amount\n"))).toBe(false);
    expect(importer.canParse(file("x.csv", ""))).toBe(false);
    expect(importer.canParse(file("x.json", ' {"format": "cashu-import"}'))).toBe(true);
    expect(importer.canParse(file("x.json", '{"format": "other"}'))).toBe(false);
    expect(importer.canParse(file("x.xlsx", `${HEADER}\n`))).toBe(false);
    expect([importer.brokerId, importer.version]).toEqual(["cashu", 1]);
  });

  // test_parse_dispatches_by_extension
  it("parse dispatches by extension", () => {
    const importer = new CanonicalImporter();
    expect(importer.parse(file("x.csv", `${HEADER}\n`)).warnings).toEqual([]);
    expect(
      importer.parse(
        file("x.json", '{"format": "cashu-import", "format_version": 1, "records": []}'),
      ).warnings,
    ).toEqual([]);
  });
});

// --- CSV structure ------------------------------------------------------------------------------

describe("CSV structure", () => {
  // test_header_problems_are_blocking_file_errors
  it("header problems are blocking file errors", () => {
    const result = csvRows([], "format_version,record,date,qty,date");
    const messages = new Map(result.warnings.map((w) => [w.message, w]));
    const unknown = [...messages.keys()].find((m) =>
      m.startsWith('Unknown column "qty"'),
    ) as string;
    expect(messages.get(unknown)?.kind).toBe(ImportWarningKind.UNKNOWN_FIELD);
    expect(messages.has('Duplicate column "date"')).toBe(true);
    const missing = csvRows([], "record,date");
    expect(missing.warnings[0]?.message).toBe('Missing required column "format_version"');
    expect(missing.warnings[0]?.kind).toBe(ImportWarningKind.MISSING_COLUMN);
    const typo = csvRows([], "format_version,record,date,quantiy");
    expect(typo.warnings[0]?.message).toContain('did you mean "quantity"');
  });

  // test_empty_invalid_utf8_and_broken_quotes
  it("empty, invalid UTF-8 and broken quotes", () => {
    expect(parseCanonicalCsv(new Uint8Array()).warnings[0]?.message).toMatch(/^File is empty/);
    const bad = parseCanonicalCsv(
      Uint8Array.from([...enc("format_version,record,date\n1,txn,"), 0xff, 0x0a]),
    );
    expect(bad.warnings[0]?.message).toContain("not valid UTF-8");
    expect(bad.warnings[0]?.kind).toBe(ImportWarningKind.FILE_FORMAT);
    const quotes = parseCanonicalCsv(enc('format_version,record,date\n1,"txn"x,2026-01-01\n'));
    expect(quotes.warnings[0]?.message).toContain("not valid CSV");
  });

  // test_bom_and_crlf_are_accepted
  it("BOM and CRLF are accepted", () => {
    const text = [
      HEADER,
      txnRow({ date: "2026-01-05", type: "deposit", currency: "PLN", cash_amount: "5" }),
    ].join("\r\n");
    const result = parseCanonicalCsv(enc(`﻿${text}\r\n`));
    expect(result.warnings).toEqual([]);
    expect(sameDecimal(result.txns[0]?.cashAmount, "5")).toBe(true);
  });

  // test_format_version_and_cell_count_per_row
  it("format_version and cell count per row", () => {
    const good = txnRow({ date: "2026-01-05", type: "deposit", currency: "PLN", cash_amount: "5" });
    const result = csvRows([good.replace("1,", "2,"), `${good},extra`, "", good]);
    const rows = byRow(result);
    expect(rows.get(0)?.message).toBe('format_version: must be 1 (got "2")');
    expect(rows.get(1)?.message).toContain("cells but the header has");
    expect(rows.has(2), "blank lines are skipped (but counted)").toBe(false);
    expect(result.txns.map((t) => t.rowIndex)).toEqual([3]);
  });
});

// --- record validation -----------------------------------------------------------------------

describe("record validation", () => {
  // test_minimal_rows_of_every_type
  it("minimal rows of every type", () => {
    const result = csvRows([
      txnRow({ date: "2026-01-02", type: "deposit", currency: "PLN", cash_amount: "1000" }),
      txnRow({
        date: "2026-01-03",
        type: "buy",
        symbol: "ABC",
        quantity: "2",
        price: "10",
        currency: "PLN",
        fee: "1",
      }),
      txnRow({
        date: "2026-01-04",
        type: "sell",
        symbol: "ABC",
        quantity: "1",
        price: "12",
        currency: "PLN",
      }),
      txnRow({
        date: "2026-01-05",
        type: "dividend",
        symbol: "ABC",
        currency: "PLN",
        gross_amount: "3",
        tax: "0.57",
      }),
      txnRow({ date: "2026-01-06", type: "interest", currency: "PLN", cash_amount: "0.12" }),
      txnRow({ date: "2026-01-07", type: "withdrawal", currency: "PLN", cash_amount: "-100" }),
      txnRow({ date: "2026-01-08", type: "fee", currency: "PLN", cash_amount: "-5" }),
      txnRow({ date: "2026-01-09", type: "tax", currency: "PLN", cash_amount: "-2" }),
      txnRow({ date: "2026-01-10", type: "fx_conversion", currency: "USD", cash_amount: "25" }),
      txnRow({
        date: "2026-01-11",
        type: "split",
        symbol: "ABC",
        currency: "PLN",
        split_ratio: "2",
      }),
      txnRow({
        date: "2026-01-12",
        type: "transfer_in",
        symbol: "XYZ",
        quantity: "3",
        currency: "PLN",
      }),
      txnRow({
        date: "2026-01-13",
        type: "transfer_out",
        symbol: "XYZ",
        quantity: "1",
        currency: "PLN",
      }),
      txnRow({
        date: "2026-01-14",
        type: "adjustment",
        symbol: "XYZ",
        quantity: "1",
        price: "9",
        currency: "PLN",
      }),
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.txns.map((t) => t.cashAmount.toString())).toEqual([
      "1000",
      "-21",
      "12",
      "2.43",
      "0.12",
      "-100",
      "-5",
      "-2",
      "25",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(sameDecimal(result.txns[1]?.grossAmount, "20")).toBe(true);
    expect(sameDecimal(result.txns[12]?.grossAmount, "9")).toBe(true);
  });

  // test_value_formats_are_strict
  it("value formats are strict", () => {
    const buy = { type: "buy", symbol: "A", quantity: "1", price: "1", currency: "PLN" };
    const result = csvRows([
      txnRow({ date: "05.01.2026", type: "deposit", currency: "PLN", cash_amount: "5" }),
      txnRow({ date: "2026-02-30", type: "deposit", currency: "PLN", cash_amount: "5" }),
      txnRow({
        date: "2026-01-05",
        time: "9:5",
        type: "deposit",
        currency: "PLN",
        cash_amount: "5",
      }),
      txnRow({
        date: "2026-01-05",
        time: "24:00",
        type: "deposit",
        currency: "PLN",
        cash_amount: "5",
      }),
      txnRow({ date: "2026-01-05", type: "deposit", currency: "PLN", cash_amount: '"1,5"' }),
      txnRow({ date: "2026-01-05", type: "deposit", currency: "PLN", cash_amount: "1e3" }),
      txnRow({ date: "2026-01-05", type: "deposit", currency: "pln", cash_amount: "5" }),
      txnRow({ date: "2026-01-05", ...buy, isin: "pl123" }),
      txnRow({ date: "2026-01-05", ...buy, quantity: "-1" }),
      txnRow({ date: "2026-01-05", ...buy, type: "Buy" }),
      txnRow({ date: "2026-01-05", ...buy, fx_rate: "0" }),
    ]);
    expect(result.txns).toEqual([]);
    const rows = byRow(result);
    const message = (row: number) => rows.get(row)?.message ?? "";
    expect(message(0)).toContain("is not a date in YYYY-MM-DD format");
    expect(message(1)).toContain("not a real calendar date");
    expect(message(2)).toContain("HH:MM or HH:MM:SS");
    expect(message(3)).toContain("not a valid time of day");
    expect(message(4)).toContain('"1,5" is not a decimal number');
    expect(message(5)).toContain("is not a decimal number");
    expect(message(6)).toContain("upper-case ISO 4217");
    expect(message(7)).toContain("is not an ISIN");
    expect(message(8)).toContain("must not be negative");
    expect(message(9)).toContain('"Buy" is not a transaction type (did you mean "buy"?)');
    expect(rows.get(9)?.kind).toBe(ImportWarningKind.UNMAPPED_TYPE);
    expect(message(10)).toBe("fx_rate: must be greater than 0");
    expect(result.warnings.every((w) => w.blocking)).toBe(true);
    expect(rows.get(0)?.kind).toBe(ImportWarningKind.INVALID_VALUE);
  });

  // test_required_values_and_type_rules
  it("required values and type rules", () => {
    const result = csvRows([
      txnRow({ type: "deposit", currency: "PLN", cash_amount: "5" }),
      txnRow({ date: "2026-01-05", currency: "PLN", cash_amount: "5" }),
      txnRow({ date: "2026-01-05", type: "buy", quantity: "1", price: "1", currency: "PLN" }),
      txnRow({ date: "2026-01-05", type: "buy", symbol: "A", price: "1", currency: "PLN" }),
      txnRow({
        date: "2026-01-05",
        type: "buy",
        symbol: "A",
        quantity: "0",
        price: "1",
        currency: "PLN",
      }),
      txnRow({
        date: "2026-01-05",
        type: "deposit",
        symbol: "A",
        currency: "PLN",
        cash_amount: "5",
      }),
      txnRow({
        date: "2026-01-05",
        type: "fee",
        quantity: "1",
        currency: "PLN",
        cash_amount: "-5",
      }),
      txnRow({ date: "2026-01-05", type: "split", symbol: "A", currency: "PLN" }),
      txnRow({
        date: "2026-01-05",
        type: "buy",
        symbol: "A",
        quantity: "1",
        price: "1",
        currency: "PLN",
        split_ratio: "2",
      }),
      txnRow({ date: "2026-01-05", type: "fx_conversion", currency: "PLN" }),
      txnRow({
        date: "2026-01-05",
        type: "fx_conversion",
        currency: "PLN",
        cash_amount: "5",
        cash_currency: "USD",
      }),
      txnRow({ date: "2026-01-05", type: "deposit", cash_amount: "5" }),
    ]);
    const rows = byRow(result);
    const message = (row: number) => rows.get(row)?.message ?? "";
    expect(message(0)).toBe("date: is required (YYYY-MM-DD)");
    expect(rows.get(0)?.kind).toBe(ImportWarningKind.MISSING_VALUE);
    expect(message(1)).toBe("type: is required");
    expect(rows.get(2)?.kind).toBe(ImportWarningKind.MISSING_INSTRUMENT);
    expect(message(3)).toBe("quantity: is required for buy");
    expect(rows.get(3)?.kind).toBe(ImportWarningKind.MISSING_QUANTITY);
    expect(message(4)).toBe("quantity: must be greater than 0");
    expect(message(5)).toBe("symbol: must be empty for deposit");
    expect(message(6)).toBe("quantity: must be empty for fee");
    expect(rows.get(7)?.kind).toBe(ImportWarningKind.UNKNOWN_SPLIT_RATIO);
    expect(message(8)).toBe("split_ratio: only allowed for split");
    expect(message(9)).toContain("is required for fx_conversion");
    expect(message(10)).toContain("each fx_conversion leg is booked in its own currency");
    expect(message(11)).toMatch(/^currency: is required/);
    expect(result.txns).toEqual([]);
  });

  // test_all_problems_of_a_row_are_reported
  it("all problems of a row are reported", () => {
    const result = csvRows([txnRow({ date: "bad", type: "buy", quantity: "x", currency: "usd" })]);
    const messages = result.warnings.map((w) => w.message);
    expect(messages.some((m) => m.startsWith("date:"))).toBe(true);
    expect(messages.some((m) => m.startsWith("quantity:"))).toBe(true);
    expect(messages.some((m) => m.startsWith("currency:"))).toBe(true);
    expect(new Set(result.warnings.map((w) => w.row))).toEqual(new Set([0]));
  });

  // test_cash_sign_rules
  it("cash sign rules", () => {
    const trade = { symbol: "A", quantity: "1", price: "1", currency: "PLN" };
    const result = csvRows([
      txnRow({ date: "2026-01-05", type: "buy", ...trade, cash_amount: "1" }),
      txnRow({ date: "2026-01-05", type: "sell", ...trade, cash_amount: "-1" }),
      txnRow({ date: "2026-01-05", type: "deposit", currency: "PLN", cash_amount: "-1" }),
      txnRow({ date: "2026-01-05", type: "withdrawal", currency: "PLN", cash_amount: "1" }),
      txnRow({ date: "2026-01-05", type: "tax", currency: "PLN", cash_amount: "3" }),
      txnRow({
        date: "2026-01-05",
        type: "dividend",
        symbol: "A",
        currency: "PLN",
        cash_amount: "-3",
      }),
      txnRow({
        date: "2026-01-05",
        type: "transfer_in",
        symbol: "A",
        quantity: "1",
        currency: "PLN",
        cash_amount: "-2",
      }),
    ]);
    const byRowList = new Map<number, ParsedWarningLike[]>();
    for (const w of result.warnings)
      byRowList.set(w.row as number, [...(byRowList.get(w.row as number) ?? []), w]);
    for (const row of [0, 1, 2, 3]) {
      expect(byRowList.get(row)?.[0]?.blocking).toBe(true);
      expect(byRowList.get(row)?.[0]?.kind).toBe(ImportWarningKind.CASH_SIGN);
    }
    for (const row of [4, 5, 6]) {
      expect(byRowList.get(row)?.[0]?.blocking).toBe(false);
      expect(byRowList.get(row)?.[0]?.kind).toBe(ImportWarningKind.CASH_SIGN);
    }
    expect(result.txns.map((t) => t.rowIndex)).toEqual([4, 5, 6]);
    expect(
      sameDecimal(result.txns[0]?.grossAmount, "3"),
      "a tax refund: gross from the cash amount",
    ).toBe(true);
  });

  // test_cross_currency_without_fx_rate_is_blocking_r5
  it("cross currency without fx_rate is blocking (R5)", () => {
    const usdBuy = {
      date: "2026-01-05",
      type: "buy",
      symbol: "A",
      quantity: "10",
      price: "100",
      currency: "USD",
      fee: "1",
      cash_currency: "PLN",
    };
    const result = csvRows([
      txnRow(usdBuy),
      txnRow({ ...usdBuy, fx_rate: "4.0" }),
      txnRow({
        date: "2026-01-05",
        type: "dividend",
        symbol: "A",
        currency: "USD",
        cash_amount: "40",
        cash_currency: "PLN",
      }),
    ]);
    const rows = byRow(result);
    expect([rows.get(0)?.blocking, rows.get(0)?.kind]).toEqual([
      true,
      ImportWarningKind.FX_MISSING,
    ]);
    expect(rows.get(0)?.message).toContain("fx_rate");
    expect(rows.get(2)?.kind).toBe(ImportWarningKind.FX_MISSING);
    expect(result.txns).toHaveLength(1);
    const [txn] = result.txns as [ParsedTxn];
    expect(sameDecimal(txn.cashAmount, "-4004")).toBe(true);
    expect([txn.cashCurrency, txn.fxRate?.toString()]).toEqual([Currencies.PLN, "4.0"]);
  });

  // test_inconsistent_amounts_are_a_warning
  it("inconsistent amounts are a warning", () => {
    const base = {
      date: "2026-01-05",
      type: "buy",
      symbol: "A",
      quantity: "1",
      price: "100",
      currency: "PLN",
      gross_amount: "100",
      fee: "1",
    };
    const result = csvRows([
      txnRow({ ...base, cash_amount: "-100" }),
      txnRow({ ...base, cash_amount: "-101.005" }),
    ]);
    expect(result.warnings).toHaveLength(1);
    const [warning] = result.warnings;
    expect([warning?.row, warning?.blocking]).toEqual([0, false]);
    expect(warning?.kind).toBe(ImportWarningKind.AMOUNT_MISMATCH);
    expect(warning?.message).toContain("expected -101");
    expect(result.txns).toHaveLength(2);
  });

  // test_fields_must_belong_to_the_record_kind
  it("fields must belong to the record kind", () => {
    const header = CSV_COLUMNS.join(",");
    const result = csvRows(
      [
        fullRow({
          record: "position",
          date: "2026-01-31",
          symbol: "A",
          quantity: "1",
          currency: "PLN",
          price: "5",
        }),
        fullRow({
          record: "rename",
          date: "2026-01-31",
          symbol: "A",
          new_symbol: "B",
          quantity: "1",
        }),
        fullRow({
          record: "txn",
          date: "2026-01-31",
          type: "deposit",
          currency: "PLN",
          cash_amount: "1",
          frozen: "true",
        }),
        fullRow({ record: "trade", date: "2026-01-31" }),
        fullRow({ date: "2026-01-31" }),
      ],
      header,
    );
    const rows = byRow(result);
    expect(rows.get(0)?.message).toBe("price: not allowed in a position record");
    expect(rows.get(0)?.kind).toBe(ImportWarningKind.UNKNOWN_FIELD);
    expect(rows.get(1)?.message).toBe("quantity: not allowed in a rename record");
    expect(rows.get(2)?.message).toBe("frozen: not allowed in a txn record");
    expect(rows.get(3)?.message).toContain('"trade" is not a record kind');
    expect(rows.get(4)?.message).toMatch(/^record: is required/);
    expect([result.txns, result.positions, result.corporateActions]).toEqual([[], [], []]);
  });

  // test_positions_and_corporate_actions
  it("positions and corporate actions", () => {
    const header = CSV_COLUMNS.join(",");
    const result = csvRows(
      [
        fullRow({
          record: "position",
          date: "2026-01-31",
          symbol: "A",
          quantity: "1",
          currency: "PLN",
          avg_price: "5",
          market_value: "6",
        }),
        fullRow({
          record: "position",
          date: "2026-01-30",
          symbol: "A",
          quantity: "2",
          currency: "PLN",
        }),
        fullRow({ record: "position", date: "2026-01-31", quantity: "2", currency: "PLN" }),
        fullRow({ record: "rename", date: "2026-02-01", symbol: "A", new_symbol: "A" }),
        fullRow({
          record: "rename",
          date: "2026-02-01",
          symbol: "A",
          new_symbol: "A",
          new_exchange: "XNAS",
          exchange: "XWAR",
        }),
        fullRow({ record: "delisting", date: "2026-02-02", symbol: "Z", frozen: "TRUE" }),
        fullRow({ record: "delisting", date: "2026-02-02", symbol: "Y" }),
        fullRow({ record: "delisting", date: "2026-02-02", symbol: "X", frozen: "yes" }),
        fullRow({ record: "delisting", date: "2026-02-02" }),
      ],
      header,
    );
    const rows = byRow(result);
    expect(rows.get(2)?.kind).toBe(ImportWarningKind.MISSING_INSTRUMENT);
    expect(rows.get(3)?.message).toMatch(/^new_symbol: a rename must change/);
    expect(rows.get(7)?.message).toContain('"yes" is not true or false');
    expect(rows.get(8)?.message).toBe("symbol: is required");
    const fileLevel = result.warnings.filter((w) => w.row === null);
    expect(fileLevel.some((w) => w.message.includes("2 different dates"))).toBe(true);
    expect(fileLevel.every((w) => w.kind === ImportWarningKind.POSITION_SNAPSHOT)).toBe(true);
    expect(result.positions).toHaveLength(2);
    expect(
      sameDecimal(result.positions[0]?.avgPrice, "5") &&
        sameDecimal(result.positions[0]?.marketValue, "6"),
    ).toBe(true);
    const [rename, frozen, plain] = result.corporateActions as [
      ParsedRename,
      ParsedDelisting,
      ParsedDelisting,
    ];
    expect([rename.kind, rename.newExchangeHint]).toEqual(["rename", "XNAS"]);
    expect([frozen.frozen, plain.frozen]).toEqual([true, false]);
  });

  // test_duplicate_positions_warn
  it("duplicate positions warn", () => {
    const header = CSV_COLUMNS.join(",");
    const line = fullRow({
      record: "position",
      date: "2026-01-31",
      isin: "PLAAA0000011",
      quantity: "1",
      currency: "PLN",
    });
    const result = csvRows([line, line], header);
    expect(result.warnings.map((w) => w.message)).toEqual([
      "2 position records for PLAAA0000011 on 2026-01-31; they are added up",
    ]);
  });

  // test_source_and_account_hint
  it("source and account hint", () => {
    const header = `${HEADER},source,account_hint`;
    const base = txnRow({ date: "2026-01-05", type: "deposit", currency: "PLN", cash_amount: "5" });
    const result = csvRows(
      [`${base},mybroker,ACC 1`, `${base},,`, `${base},mybroker,ACC 2`],
      header,
    );
    expect([result.source, result.accountHint]).toEqual(["mybroker", "ACC 1"]);
    expect(result.warnings).toHaveLength(1);
    const [warning] = result.warnings;
    expect([warning?.row, warning?.kind]).toEqual([2, ImportWarningKind.INCONSISTENT_FILE]);
    const bad = csvRows([`${base},My Broker,`], header);
    expect(bad.warnings[0]?.message).toContain("source:");
    expect(bad.source).toBeNull();
  });
});

type ParsedWarningLike = ImportParseResult["warnings"][number];

// --- JSON ----------------------------------------------------------------------------------------

describe("JSON", () => {
  // test_json_numbers_are_exact_and_strings_work_too
  it("numbers are exact and strings work too", () => {
    const result = jsonDoc([
      '{"record": "txn", "date": "2026-01-05", "type": "buy", "symbol": "A", "quantity": 0.1, "price": "0.2", "currency": "PLN", "fee": 0}',
      '{"record": "delisting", "date": "2026-01-06", "symbol": "A", "frozen": true}',
      '{"record": "txn", "date": "2026-01-07", "type": "deposit", "currency": "PLN", "cash_amount": 1E+2, "note": null}',
    ]);
    expect(result.warnings).toEqual([]);
    const [buy, deposit] = result.txns as [ParsedTxn, ParsedTxn];
    expect(sameDecimal(buy.quantity, "0.1") && sameDecimal(buy.grossAmount, "0.02")).toBe(true);
    expect(sameDecimal(deposit.cashAmount, "100")).toBe(true);
    expect((result.corporateActions[0] as ParsedDelisting).frozen).toBe(true);
  });

  // test_json_document_structure_errors
  it("document structure errors", () => {
    expect(parseCanonicalJson(enc("[]")).warnings[0]?.message).toBe(
      "The JSON document must be an object",
    );
    expect(parseCanonicalJson(enc("{")).warnings[0]?.message).toContain("not valid JSON");
    expect(
      parseCanonicalJson(enc('{"format": "cashu-import", "format": "x"}')).warnings[0]?.message,
    ).toContain("duplicate key");
    expect(
      parseCanonicalJson(enc('{"format": "cashu-import", "format_version": NaN}')).warnings[0]
        ?.message,
    ).toContain("not valid JSON");
    const result = parseCanonicalJson(
      enc('{"format": "other", "format_version": "1", "record": []}'),
    );
    const messages = result.warnings.map((w) => w.message);
    expect(messages).toContain('format: must be "cashu-import"');
    expect(messages).toContain("format_version: must be the number 1");
    expect(messages).toContain("records: must be an array of record objects");
    expect(
      messages.some((m) => m.startsWith('Unknown key "record" (did you mean "records"?)')),
    ).toBe(true);
    expect(result.warnings.every((w) => w.kind)).toBe(true);
    const boolean = parseCanonicalJson(
      enc('{"format": "cashu-import", "format_version": true, "records": []}'),
    );
    expect(boolean.warnings[0]?.message).toBe("format_version: must be the number 1");
  });

  // test_json_record_errors
  it("record errors", () => {
    const result = jsonDoc([
      '"not an object"',
      '{"record": "txn", "date": "2026-01-05", "type": "deposit", "currency": "PLN", "cash_amount": 1, "source": "x"}',
      '{"record": "txn", "date": "2026-01-05", "type": "deposit", "currency": "PLN", "cash_amount": [1]}',
      '{"record": "txn", "date": "2026-01-05", "type": "buy", "symbol": 123, "quantity": 1, "price": 1, "currency": "PLN"}',
      '{"record": "txn", "date": "2026-01-05", "type": "buy", "symbol": "A", "quantity": true, "price": 1, "currency": "PLN", "qty": 1}',
    ]);
    const rows = new Map<number, string[]>();
    for (const w of result.warnings)
      rows.set(w.row as number, [...(rows.get(w.row as number) ?? []), w.message]);
    expect(rows.get(0)).toEqual(["Record must be a JSON object"]);
    expect(rows.get(1)).toEqual(["source: belongs at the top level of the document"]);
    expect(rows.get(2)).toEqual(["cash_amount: must be a single value"]);
    expect(rows.get(3)).toEqual(["symbol: must be text (in JSON a quoted string)"]);
    expect(rows.get(4)?.some((m) => m.startsWith("qty: unknown field"))).toBe(true);
    expect(rows.get(4)?.some((m) => m.startsWith('quantity: "true" is not a decimal number'))).toBe(
      true,
    );
    expect(result.txns).toEqual([]);
  });

  // test_json_top_level_source_and_account_hint
  it("top level source and account hint", () => {
    const result = jsonDoc([], '"source": "examplebroker", "account_hint": " A-1 "');
    expect([result.source, result.accountHint]).toEqual(["examplebroker", "A-1"]);
    expect(jsonDoc([], '"source": 5').warnings[0]?.message).toBe("source: must be a string");
  });
});

// test_record_fields_cover_every_parsed_txn_field
it("record fields cover every parsed txn field", () => {
  // Python walks dataclasses.fields(ParsedTxn); TS has no field reflection, so the list is spelled out
  // (a new ParsedTxn field fails the type check of `parsedTxn` and this list at once).
  const mapping: Record<string, string> = {
    tradeDate: "date",
    tradeTime: "time",
    exchangeHint: "exchange",
  };
  const snake = (name: string) => name.replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`);
  const fields = [
    "tradeDate",
    "type",
    "currency",
    "grossAmount",
    "cashAmount",
    "cashCurrency",
    "externalRef",
    "tradeTime",
    "settleDate",
    "symbol",
    "isin",
    "name",
    "exchangeHint",
    "quantity",
    "price",
    "fee",
    "tax",
    "fxRate",
    "splitRatio",
    "note",
  ];
  for (const field of fields)
    expect(RECORD_FIELDS.has(mapping[field] ?? snake(field)), field).toBe(true);
});

// test_raw_row_is_kept[csv] / [json]
describe("raw row", () => {
  it("is kept for CSV", () => {
    const result = csvRows([
      txnRow({ date: "2026-01-05", type: "deposit", currency: "PLN", cash_amount: "5" }),
    ]);
    expect(result.txns[0]?.rawRow.get("cash_amount")).toBe("5");
    expect(result.txns[0]?.rawRow.get("format_version")).toBe("1");
  });

  it("is kept for JSON", () => {
    const result = jsonDoc([
      '{"record": "txn", "date": "2026-01-05", "type": "deposit", "currency": "PLN", "cash_amount": 5.50}',
    ]);
    expect(result.txns[0]?.rawRow.get("cash_amount")).toBe("5.50");
  });
});

// Not in the Python file: the id the canonical importer reports, and a file that tries to exhaust memory.
describe("TypeScript-only guards", () => {
  it("the canonical broker id is cashu", () => {
    expect(CANONICAL_BROKER_ID).toBe("cashu");
  });

  it("a huge exponent neither hangs nor crashes the reader", () => {
    // PARITY(S17a): Python formats the value in plain notation (a trillion digits) and runs out of
    // memory; here it is a blocking row error.
    const result = jsonDoc([
      '{"record": "txn", "date": "2026-01-05", "type": "deposit", "currency": "PLN", "cash_amount": 1e999999999999}',
    ]);
    expect(result.txns).toEqual([]);
    expect(result.warnings.map((w) => [w.row, w.blocking, w.kind])).toEqual([
      [0, true, ImportWarningKind.INVALID_VALUE],
    ]);
    expect(result.warnings[0]?.message).toContain("cash_amount: 1E+999999999999 is out of range");
  });
});
