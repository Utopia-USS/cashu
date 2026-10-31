import { describe, expect, it } from "vitest";
import { Decimal } from "../../decimal.js";
import { Currencies, TxnType } from "../domain/index.js";
import {
  hasBlockingWarnings,
  type ImportFile,
  type ImportWarning,
  ImportWarningKind,
  type ParsedTxn,
} from "./contract.js";
import { AmountSign, CsvField, csvMapping, RowErrorPolicy } from "./csvMapping.js";
import { decimalFormat } from "./csvValues.js";
import { GenericCsvImporter } from "./genericCsv.js";
import {
  csvFile,
  d,
  day,
  enc,
  plExportCp1250,
  plExportUtf8Bom,
  plMapping,
  SIMPLE_HEADER,
  simpleMapping,
} from "./testing/support.js";
import { ImportTextEncoding } from "./text.js";

// Translation of tests/investments/importing/test_imp_generic_csv.py.

const plFile = (name = "pl_broker.csv", cp1250 = false): ImportFile => ({
  name,
  content: cp1250 ? plExportCp1250() : plExportUtf8Bom(),
});

/**
 * Python `==` of frozen dataclass values: decimals by value, maps by entries, every field compared
 * (`ParsedTxn.raw_row` has `compare=True`).
 */
function pyEq(a: unknown, b: unknown): boolean {
  if (a instanceof Decimal || b instanceof Decimal) {
    return a instanceof Decimal && b instanceof Decimal && a.eq(b);
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    return [...a].every(([key, value]) => b.has(key) && pyEq(value, b.get(key)));
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!(Array.isArray(a) && Array.isArray(b)) || a.length !== b.length) return false;
    return a.every((item, index) => pyEq(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (key) =>
        key in b && pyEq((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return a === b;
}

const byRow = (warnings: readonly ImportWarning[]): Map<number | null, ImportWarning> =>
  new Map(warnings.map((warning) => [warning.row, warning]));

const at = <T>(items: readonly T[], index: number): T => {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
};

const only = <T>(items: readonly T[]): T => {
  expect(items).toHaveLength(1);
  return at(items, 0);
};

describe("can_parse", () => {
  // test_accepts_the_fixture_in_its_own_encoding
  it("accepts the fixture in its own encoding", () => {
    expect(new GenericCsvImporter(plMapping()).canParse(plFile())).toBe(true);
    expect(
      new GenericCsvImporter(plMapping("windows-1250")).canParse(plFile(undefined, true)),
    ).toBe(true);
    expect(new GenericCsvImporter(plMapping("auto")).canParse(plFile(undefined, true))).toBe(true);
  });

  // test_does_not_claim_other_headers_encodings_extensions_or_binary
  it("does not claim other headers, encodings, extensions or binary", () => {
    const importer = new GenericCsvImporter(plMapping());
    expect(importer.canParse(csvFile("Date;Type;Amount\n2026-01-05;buy;1\n"))).toBe(false);
    expect(importer.canParse(csvFile(""))).toBe(false);
    // Polish header letters garble as UTF-8
    expect(importer.canParse(plFile(undefined, true))).toBe(false);
    expect(importer.canParse({ name: "export.xlsx", content: plExportUtf8Bom() })).toBe(false);
    const binary = Uint8Array.from({ length: 512 }, (_, i) => (i * 37) % 256);
    expect(importer.canParse({ name: "x.csv", content: binary })).toBe(false);
  });

  // test_large_utf8_file_is_sniffed_as_utf8_by_auto_even_when_64k_cuts_a_character
  it("large UTF-8 file is sniffed as UTF-8 by auto even when 64k cuts a character", () => {
    const mapping = csvMapping({
      encoding: ImportTextEncoding.AUTO,
      delimiter: ";",
      defaultCurrency: Currencies.PLN,
      columns: new Map([
        [CsvField.TRADE_DATE, "Data"],
        [CsvField.TYPE, "Typ"],
        [CsvField.CASH_AMOUNT, "Kwota"],
        [CsvField.NOTE, "Opłata"],
      ]),
    });
    const build = (pad: string): Uint8Array => {
      const lines = ["Data;Typ;Kwota;Opłata"];
      for (let i = 0; i < 2000; i++) {
        lines.push(`2026-01-05;deposit;1;${i === 0 ? pad : ""}${"ż".repeat(20)}`);
      }
      return enc(`${lines.join("\n")}\n`);
    };
    let data = build("");
    if (((data[64 * 1024] as number) & 0xc0) !== 0x80) data = build("x");
    expect((data[64 * 1024] as number) & 0xc0).toBe(0x80);
    expect(new GenericCsvImporter(mapping).canParse({ name: "big.csv", content: data })).toBe(true);
  });

  // test_header_names_match_trimmed_and_case_insensitively
  it("header names match trimmed and case-insensitively", () => {
    const importer = new GenericCsvImporter(simpleMapping());
    expect(
      importer.canParse(
        csvFile(" REF ,Date,TYPE,symbol,isin,exchange,qty,price,ccy,fee,cash,extra\n"),
      ),
    ).toBe(true);
    expect(
      importer.canParse(csvFile("ref,date,type,symbol,isin,exchange,qty,price,ccy,fee\n")),
    ).toBe(false);
  });
});

describe("parse", () => {
  // test_utf8_bom_fixture_decimal_comma_thousands_types_signs_derived_amounts
  it("UTF-8 BOM fixture: decimal comma, thousands, types, signs, derived amounts", () => {
    const result = new GenericCsvImporter(plMapping()).parse(plFile());
    expect(hasBlockingWarnings(result)).toBe(false);
    expect(result.txns).toHaveLength(7);
    const warning = only(result.warnings);
    expect(warning.message).toBe('Type "Blokada środków" is ignored by the mapping');
    expect(warning.row).toBe(7);

    const deposit = at(result.txns, 0);
    expect(deposit.type).toBe(TxnType.DEPOSIT);
    expect(deposit.tradeDate).toBe(day("2026-01-05"));
    expect(deposit.cashAmount.eq(d("10000"))).toBe(true);
    expect(deposit.grossAmount.eq(d("10000"))).toBe(true);
    expect(deposit.note).toBe("Wpłata własna");

    const buy = at(result.txns, 1);
    expect(buy.type).toBe(TxnType.BUY);
    expect([buy.symbol, buy.isin, buy.name]).toEqual([
      "ZGJ",
      "PLZGJ0000010",
      "Zażółć Gęślą Jaźń SA",
    ]);
    expect(buy.exchangeHint).toBe("GPW");
    expect(pyEq([buy.quantity, buy.price, buy.grossAmount], [d("10"), d("62.5"), d("625")])).toBe(
      true,
    );
    expect(pyEq([buy.fee, buy.cashAmount], [d("3.13"), d("-628.13")])).toBe(true);
    expect(buy.currency).toBe(Currencies.PLN);
    expect(buy.cashCurrency).toBe(Currencies.PLN);
    expect(buy.rawRow.get("Giełda")).toBe("GPW");
    expect(at(result.txns, 2).rowIndex).toBe(2);
    // two identical rows are both parsed
    const twin: ParsedTxn = { ...at(result.txns, 2), rowIndex: 1 };
    expect(pyEq(twin, buy)).toBe(true);

    const etf = at(result.txns, 3);
    expect(pyEq([etf.price, etf.cashAmount], [d("1234.5"), d("-3708.5")])).toBe(true);
    const sell = at(result.txns, 4);
    expect(sell.type === TxnType.SELL && sell.cashAmount.eq(d("348.25"))).toBe(true);
    expect(sell.note).toBe("Częściowa sprzedaż");
    const dividend = at(result.txns, 5);
    expect(dividend.quantity).toBeNull();
    // derived from the cash amount
    expect(dividend.grossAmount.eq(d("12.15"))).toBe(true);
    expect(dividend.note).toBe("DYWIDENDA ŹRÓDŁO ŁÓDŹ ĄĆĘŃÓŚŻ");
    const fee = at(result.txns, 6);
    expect(fee.type).toBe(TxnType.FEE);
    expect(pyEq([fee.cashAmount, fee.grossAmount], [d("-9.99"), d("9.99")])).toBe(true);
  });

  // test_windows_1250_fixture_parses_to_the_same_transactions
  it("Windows-1250 fixture parses to the same transactions", () => {
    const utf8 = new GenericCsvImporter(plMapping()).parse(plFile());
    const cp1250 = new GenericCsvImporter(plMapping("windows-1250")).parse(plFile(undefined, true));
    expect(cp1250.warnings).toEqual(utf8.warnings);
    expect(pyEq(cp1250.txns, utf8.txns)).toBe(true);
    expect(at(cp1250.txns, 1).name).toBe("Zażółć Gęślą Jaźń SA");
  });

  // test_windows_1250_file_read_as_utf8_is_one_blocking_error
  it("Windows-1250 file read as UTF-8 is one blocking error", () => {
    const mapping = csvMapping({
      defaultCurrency: Currencies.PLN,
      delimiter: ";",
      columns: new Map([
        [CsvField.TRADE_DATE, "Data"],
        [CsvField.TYPE, "Typ"],
        [CsvField.CASH_AMOUNT, "Kwota"],
      ]),
    });
    const result = new GenericCsvImporter(mapping).parse(plFile(undefined, true));
    expect(result.txns).toEqual([]);
    const warning = only(result.warnings);
    expect(warning.blocking).toBe(true);
    expect(warning.message).toContain("not valid UTF-8");
  });

  // test_missing_columns_and_missing_header_are_blocking
  it("missing columns and missing header are blocking", () => {
    const result = new GenericCsvImporter(simpleMapping()).parse(
      csvFile("ref,date,type\n1,2026-01-05,buy\n"),
    );
    expect(hasBlockingWarnings(result)).toBe(true);
    expect(at(result.warnings, 0).message.startsWith('Missing columns: "symbol"')).toBe(true);
    const empty = new GenericCsvImporter(simpleMapping()).parse(csvFile(""));
    expect(at(empty.warnings, 0).message).toBe("File has no header row at record 0");
  });

  // test_amount_sign_absolute_derives_the_direction_from_the_type
  it("amount_sign absolute derives the direction from the type", () => {
    const mapping = csvMapping({
      amountSign: AmountSign.ABSOLUTE,
      defaultCurrency: Currencies.PLN,
      columns: new Map([
        [CsvField.TRADE_DATE, "date"],
        [CsvField.TYPE, "type"],
        [CsvField.CASH_AMOUNT, "amount"],
        [CsvField.TAX, "tax"],
      ]),
    });
    const result = new GenericCsvImporter(mapping).parse(
      csvFile(
        "date,type,amount,tax\n2026-01-05,deposit,100,\n2026-01-06,withdrawal,40,\n" +
          "2026-01-07,dividend,85,15\n",
      ),
    );
    expect(
      pyEq(
        result.txns.map((t) => t.cashAmount),
        [d("100"), d("-40"), d("85")],
      ),
    ).toBe(true);
    // net 85 + tax 15
    expect(at(result.txns, 2).grossAmount.eq(d("100"))).toBe(true);
    const fx = new GenericCsvImporter(mapping).parse(
      csvFile("date,type,amount,tax\n2026-01-05,fx_conversion,100,\n"),
    );
    expect(at(fx.warnings, 0).blocking).toBe(true);
    expect(at(fx.warnings, 0).message).toContain("signed amounts");
  });

  // test_cash_derived_from_gross_fee_and_tax_when_the_file_has_none
  it("cash derived from gross, fee and tax when the file has none", () => {
    const mapping = csvMapping({
      defaultCurrency: Currencies.USD,
      columns: new Map([
        [CsvField.TRADE_DATE, "date"],
        [CsvField.TYPE, "type"],
        [CsvField.QUANTITY, "qty"],
        [CsvField.PRICE, "price"],
        [CsvField.FEE, "fee"],
        [CsvField.SPLIT_RATIO, "ratio"],
      ]),
    });
    const result = new GenericCsvImporter(mapping).parse(
      csvFile(
        "date,type,qty,price,fee,ratio\n2026-01-05,buy,-2,10,1,\n2026-01-06,sell,2,12,1,\n" +
          "2026-01-07,split,,,,4\n",
      ),
    );
    expect(hasBlockingWarnings(result)).toBe(false);
    // quantities are absolute
    expect(at(result.txns, 0).quantity?.eq(d("2"))).toBe(true);
    expect(at(result.txns, 0).cashAmount.eq(d("-21"))).toBe(true);
    expect(at(result.txns, 1).cashAmount.eq(d("23"))).toBe(true);
    const split = at(result.txns, 2);
    expect(pyEq([split.cashAmount, split.grossAmount], [d("0"), d("0")])).toBe(true);
    expect(split.splitRatio?.eq(d("4"))).toBe(true);
    expect(at(result.txns, 0).currency).toBe(Currencies.USD);
  });

  // test_cash_derived_across_currencies_uses_fx_rate_else_blocking_r5
  it("cash derived across currencies uses fx_rate, else blocking (R5)", () => {
    const mapping = csvMapping({
      columns: new Map([
        [CsvField.EXTERNAL_REF, "ref"],
        [CsvField.TRADE_DATE, "date"],
        [CsvField.TYPE, "type"],
        [CsvField.SYMBOL, "symbol"],
        [CsvField.QUANTITY, "qty"],
        [CsvField.PRICE, "price"],
        [CsvField.CURRENCY, "ccy"],
        [CsvField.FEE, "fee"],
        [CsvField.CASH_AMOUNT, "cash"],
        [CsvField.CASH_CURRENCY, "cash_ccy"],
        [CsvField.FX_RATE, "fx"],
        [CsvField.GROSS_AMOUNT, "gross"],
      ]),
    });
    const result = new GenericCsvImporter(mapping).parse(
      csvFile(
        "ref,date,type,symbol,qty,price,ccy,fee,cash,cash_ccy,fx,gross\n" +
          "a,2026-01-05,buy,AAPL,10,100,USD,1,,PLN,4.0,\n" + // -(1000 + 1) USD x 4.0 = -4004 PLN
          "b,2026-01-06,sell,AAPL,5,110,USD,0,,PLN,4.1,\n" + // 550 USD x 4.1 = 2255 PLN
          "c,2026-01-07,dividend,AAPL,,,USD,0,40,PLN,4.0,\n" + // gross from cash: 40 / 4.0 = 10 USD
          "d,2026-01-08,buy,AAPL,1,100,USD,0,,USD,,\n" + // same currency: no rate needed
          "e,2026-01-09,buy,AAPL,10,100,USD,0,,PLN,,\n" + // no rate: never guess
          "f,2026-01-10,dividend,AAPL,,,USD,0,40,PLN,,\n", // no rate, no gross: never guess
      ),
    );
    expect(result.txns.map((t) => t.externalRef)).toEqual(["a", "b", "c", "d"]);
    expect(
      pyEq(
        result.txns.map((t) => [t.cashAmount, t.cashCurrency]),
        [
          [d("-4004"), Currencies.PLN],
          [d("2255"), Currencies.PLN],
          [d("40"), Currencies.PLN],
          [d("-100"), Currencies.USD],
        ],
      ),
    ).toBe(true);
    expect(
      pyEq(
        result.txns.map((t) => t.grossAmount),
        [d("1000"), d("550"), d("10"), d("100")],
      ),
    ).toBe(true);
    expect(at(result.txns, 0).fxRate?.eq(d("4.0"))).toBe(true);
    const rows = byRow(result.warnings);
    expect(rows.get(4)?.blocking).toBe(true);
    expect(rows.get(4)?.message).toContain("cash_currency PLN differs from currency USD: fx_rate");
    expect(rows.get(5)?.blocking).toBe(true);
    expect(rows.get(5)?.message).toContain(
      "gross_amount is empty and cash_currency PLN differs from currency USD",
    );
  });

  const ERROR_ROWS =
    `${SIMPLE_HEADER}\n` +
    "a,2026-01-05,buy,PKN,,GPW,1,10,PLN,0,-10\n" +
    "b,2026-01-06,teleport,PKN,,GPW,1,10,PLN,0,-10\n" +
    "c,05.01.2026,buy,PKN,,GPW,1,10,PLN,0,-10\n" +
    "d,2026-01-07,buy,PKN,,GPW,1,ten,PLN,0,-10\n" +
    "e,2026-01-07,buy,PKN,,GPW,1,10,ZL,0,-10\n" +
    ",,,,,,,,,,\n" +
    "f,,,PKN,,,,,,,\n";

  // test_row_errors_block_by_default
  it("row errors block by default", () => {
    const result = new GenericCsvImporter(simpleMapping()).parse(csvFile(ERROR_ROWS));
    expect(result.txns.map((t) => t.externalRef)).toEqual(["a"]);
    const rows = byRow(result.warnings);
    expect(rows.get(1)?.message).toContain('unknown type "teleport"');
    expect(rows.get(2)?.message).toContain('trade_date: "05.01.2026"');
    expect(rows.get(3)?.message).toContain('price: "ten" is not a number');
    expect(rows.get(4)?.message).toContain('currency: "ZL"');
    expect([1, 2, 3, 4].every((i) => rows.get(i)?.blocking === true)).toBe(true);
    // empty records are skipped silently
    expect(rows.has(5)).toBe(false);
    // a row without date and type is skipped
    expect(rows.get(6)?.blocking).toBe(false);
  });

  // test_row_errors_are_skipped_with_on_row_error_skip
  it("row errors are skipped with on_row_error skip", () => {
    const mapping = csvMapping({ ...simpleMapping(), onRowError: RowErrorPolicy.SKIP });
    const result = new GenericCsvImporter(mapping).parse(csvFile(ERROR_ROWS));
    expect(hasBlockingWarnings(result)).toBe(false);
    expect(result.warnings.filter((w) => w.message.endsWith("row skipped"))).toHaveLength(4);
  });

  // test_quoted_fields_header_offset_wire_types_and_invalid_isins
  it("quoted fields, header offset, wire types and invalid ISINs", () => {
    const mapping = csvMapping({
      headerRow: 1,
      numberFormat: decimalFormat(".", ","),
      columns: new Map([
        [CsvField.TRADE_DATE, "date"],
        [CsvField.TYPE, "type"],
        [CsvField.NAME, "name"],
        [CsvField.ISIN, "isin"],
        [CsvField.CURRENCY, "ccy"],
        [CsvField.CASH_AMOUNT, "cash"],
      ]),
    });
    const result = new GenericCsvImporter(mapping).parse(
      csvFile(
        "Account statement 2026\n" +
          "date,type,name,isin,ccy,cash\n" +
          '2026-01-05,Interest,"Savings, ""plus""",pl123,EUR,"1,234.5"\n',
      ),
    );
    const txn = only(result.txns);
    // type wire names work without a types map
    expect(txn.type).toBe(TxnType.INTEREST);
    expect(txn.name).toBe('Savings, "plus"');
    expect(txn.isin).toBeNull();
    expect(at(result.warnings, 0).message).toBe('Ignored invalid ISIN "PL123"');
    expect(txn.cashAmount.eq(d("1234.5"))).toBe(true);
  });

  // test_time_of_day_from_the_date_cell_r9
  it("time of day from the date cell (R9)", () => {
    const result = new GenericCsvImporter(simpleMapping()).parse(
      csvFile(`${SIMPLE_HEADER}\nr1,2026-09-02 10:00,buy,PKN,,GPW,10,60,PLN,0,-600\n`),
    );
    expect(at(result.txns, 0).tradeTime).toEqual({ hour: 10, minute: 0, second: 0 });
    expect(at(result.txns, 0).tradeDate).toBe(day("2026-09-02"));
  });

  // test_importer_identity
  it("importer identity", () => {
    const importer = new GenericCsvImporter(simpleMapping({ brokerId: "mbank" }));
    expect([importer.brokerId, importer.displayName, importer.version]).toEqual([
      "mbank",
      "Generic CSV",
      1,
    ]);
  });

  // test_warning_kinds_of_row_errors
  it("warning kinds of row errors", () => {
    const result = new GenericCsvImporter(simpleMapping()).parse(csvFile(ERROR_ROWS));
    const kinds = new Map(result.warnings.map((w) => [w.row, w.kind]));
    expect(kinds.get(1)).toBe(ImportWarningKind.UNMAPPED_TYPE);
    expect(kinds.get(2)).toBe(ImportWarningKind.INVALID_VALUE);
    expect(kinds.get(6)).toBe(ImportWarningKind.IGNORED_ROW);
    const missing = new GenericCsvImporter(simpleMapping()).parse(csvFile("ref,date\n"));
    expect(at(missing.warnings, 0).kind).toBe(ImportWarningKind.MISSING_COLUMN);
    const skipping = new GenericCsvImporter(
      csvMapping({ ...simpleMapping(), onRowError: RowErrorPolicy.SKIP }),
    );
    expect(new Set(skipping.parse(csvFile(ERROR_ROWS)).warnings.map((w) => w.kind))).toEqual(
      new Set([ImportWarningKind.IGNORED_ROW]),
    );
    const fx = new GenericCsvImporter(
      csvMapping({
        columns: new Map([
          [CsvField.TRADE_DATE, "date"],
          [CsvField.TYPE, "type"],
          [CsvField.QUANTITY, "qty"],
          [CsvField.PRICE, "price"],
          [CsvField.CURRENCY, "ccy"],
          [CsvField.CASH_CURRENCY, "cash_ccy"],
        ]),
      }),
    ).parse(csvFile("date,type,qty,price,ccy,cash_ccy\n2026-01-05,buy,1,1,USD,PLN\n"));
    expect(at(fx.warnings, 0).kind).toBe(ImportWarningKind.FX_MISSING);
  });
});
