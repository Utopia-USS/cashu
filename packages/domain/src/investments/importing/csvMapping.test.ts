/// <reference types="node" />
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { Currencies, TxnType } from "../domain/index.js";
import {
  AmountSign,
  CSV_FIELDS,
  CsvField,
  type CsvMappingIssue,
  csvMappingErrorText,
  csvMappingFromYaml,
  csvMappingIssueText,
  KNOWN_KEYS,
  RowErrorPolicy,
} from "./csvMapping.js";
import { decimalFormat } from "./csvValues.js";
import { plMapping } from "./testing/support.js";
import { ImportTextEncoding } from "./text.js";

// Translation of tests/investments/importing/test_imp_csv_mapping.py. `CsvMapping.from_yaml` returns
// `{ok, mapping}` / `{ok: false, issues}` here instead of raising `CsvMappingError`.

const MINIMAL = `version: 1
default_currency: PLN
columns:
  trade_date: Date
  type: Type
  cash_amount: Amount
`;

/** `example_mapping_yaml()`: the shipped example next to `csvMapping.ts`. */
const exampleMappingYaml = (): string =>
  readFileSync(new URL("./generic_csv_example.yaml", import.meta.url), "utf8");

function parse(text: string) {
  const parsed = csvMappingFromYaml(text);
  if (!parsed.ok) throw new Error(`unexpected issues: ${JSON.stringify(parsed.issues)}`);
  return parsed.mapping;
}

/** `issues()`: the mapping must be rejected; its issues. */
function issues(text: string): readonly CsvMappingIssue[] {
  const parsed = csvMappingFromYaml(text);
  if (parsed.ok) throw new Error("expected CsvMappingError");
  return parsed.issues;
}

// test_parses_every_key_of_the_fixture_mapping
it("parses every key of the fixture mapping", () => {
  const mapping = plMapping();
  expect(mapping.brokerId).toBe("generic_csv");
  expect(mapping.displayName).toBe("Synthetic PL broker");
  expect(mapping.encoding).toBe(ImportTextEncoding.UTF8);
  expect(mapping.delimiter).toBe(";");
  expect(mapping.numberFormat).toEqual(decimalFormat(",", " "));
  expect(mapping.dateFormats).toEqual(["dd.MM.yyyy"]);
  expect(mapping.defaultCurrency).toBe(Currencies.PLN);
  expect(mapping.amountSign).toBe(AmountSign.SIGNED);
  expect(mapping.columns.get(CsvField.EXCHANGE)).toBe("Giełda");
  expect(mapping.columns.get(CsvField.QUANTITY)).toBe("Ilość");
  expect(mapping.columns.size).toBe(12);
  expect(mapping.types.get("Sprzedaż")).toBe(TxnType.SELL);
  expect(mapping.types.get("Wpłata")).toBe(TxnType.DEPOSIT);
  expect(mapping.ignoredTypes).toEqual(new Set(["Blokada środków"]));
  expect(plMapping("windows-1250").encoding).toBe(ImportTextEncoding.WINDOWS_1250);
});

// test_defaults_of_a_minimal_mapping
it("defaults of a minimal mapping", () => {
  const mapping = parse(MINIMAL);
  expect(mapping.brokerId).toBe("generic_csv");
  expect(mapping.displayName).toBe("Generic CSV");
  expect(mapping.encoding).toBe(ImportTextEncoding.UTF8);
  expect(mapping.delimiter).toBe(",");
  expect(mapping.quote).toBe('"');
  expect(mapping.numberFormat).toEqual(decimalFormat());
  expect(mapping.dateFormats).toEqual(["yyyy-MM-dd"]);
  expect(mapping.headerRow).toBe(0);
  expect(mapping.amountSign).toBe(AmountSign.SIGNED);
  expect(mapping.onRowError).toBe(RowErrorPolicy.BLOCK);
  expect(mapping.extensions).toEqual(["csv", "txt", "tsv"]);
  expect(mapping.types.size).toBe(0);
});

// test_tab_delimiter_keywords_and_scalar_text
it("tab delimiter, keywords and scalar text", () => {
  const mapping = parse(`version: 1
broker_id: mbank
delimiter: tab
thousands_separator: space
decimal_separator: ","
date_formats: dd-MM-yyyy
header_row: 2
amount_sign: absolute
on_row_error: skip
extensions: [CSV, .txt]
columns:
  trade_date: Date
  type: Type
  currency: 2024
  gross_amount: Value
types:
  NO: buy
`);
  expect(mapping.brokerId).toBe("mbank");
  expect(mapping.delimiter).toBe("\t");
  expect(mapping.numberFormat.thousandsSeparator).toBe(" ");
  expect(mapping.dateFormats).toEqual(["dd-MM-yyyy"]);
  expect(mapping.headerRow).toBe(2);
  expect(mapping.amountSign).toBe(AmountSign.ABSOLUTE);
  expect(mapping.onRowError).toBe(RowErrorPolicy.SKIP);
  expect(mapping.extensions).toEqual(["csv", "txt"]);
  // numeric YAML header text stays text
  expect(mapping.columns.get(CsvField.CURRENCY)).toBe("2024");
  // no YAML 1.1 boolean coercion of keys
  expect([...mapping.types]).toEqual([["NO", TxnType.BUY]]);
});

// test_the_shipped_example_documents_a_valid_mapping_with_every_key_and_field
it("the shipped example documents a valid mapping with every key and field", () => {
  const text = exampleMappingYaml();
  const mapping = parse(text);
  // the example shows every field
  expect(new Set(mapping.columns.keys())).toEqual(new Set(CSV_FIELDS));
  expect(mapping.ignoredTypes.size).toBeGreaterThan(0);
  const values = new Set(mapping.types.values());
  for (const type of [TxnType.BUY, TxnType.SELL, TxnType.FX_CONVERSION]) {
    expect(values.has(type)).toBe(true);
  }
  for (const key of KNOWN_KEYS) {
    expect(text.includes(`\n${key}:`), `the example documents ${key}`).toBe(true);
  }
  // the em dash character is not used
  expect(text.includes(String.fromCodePoint(0x2014))).toBe(false);
});

// test_unknown_keys_fields_and_types_have_suggestions_and_positions
it("unknown keys, fields and types have suggestions and positions", () => {
  const found = issues(`version: 1
decimal_seperator: ","
default_currency: PLN
columns:
  trade_dat: Date
  type: Type
  cash_amount: Amount
types:
  Kupno: bye
`);
  const byPath = new Map(found.map((issue) => [issue.path, issue]));
  for (const path of ["decimal_seperator", "columns.trade_dat", "types.Kupno"]) {
    expect(byPath.has(path)).toBe(true);
  }
  const typo = byPath.get("decimal_seperator") as CsvMappingIssue;
  expect(typo.message).toContain('did you mean "decimal_separator"');
  expect([typo.line, typo.column]).toEqual([2, 1]);
  const field = byPath.get("columns.trade_dat") as CsvMappingIssue;
  expect(field.message).toContain('"trade_date"');
  expect([field.line, field.column]).toEqual([5, 3]);
  expect(byPath.get("types.Kupno")?.message).toContain('"buy"');
  expect(found.map((issue) => issue.message)).toContain("Missing required field trade_date");
  expect(csvMappingIssueText(typo)).toContain("line 2:1: decimal_seperator: Unknown key");
});

// test_validates_required_content_and_value_domains
it("validates required content and value domains", () => {
  const found = issues(`version: 2
broker_id: My Broker
encoding: latin2
delimiter: ";;"
decimal_separator: ","
thousands_separator: ","
date_formats: [MM.yyyy]
header_row: -1
default_currency: zloty
amount_sign: reversed
columns:
  symbol: Ticker
`);
  const paths = new Set(found.map((issue) => issue.path));
  for (const path of [
    "version",
    "broker_id",
    "encoding",
    "delimiter",
    "thousands_separator",
    "date_formats[0]",
    "header_row",
    "default_currency",
    "amount_sign",
    "columns",
  ]) {
    expect(paths.has(path), path).toBe(true);
  }
  const columnMessages = new Set(
    found.filter((issue) => issue.path === "columns").map((issue) => issue.message),
  );
  for (const message of [
    "Missing required field trade_date",
    "Missing required field type",
    "Map cash_amount, gross_amount, or quantity and price",
    "Map a currency column or set default_currency",
  ]) {
    expect(columnMessages.has(message), message).toBe(true);
  }
});

// test_duplicates_and_value_shapes_are_errors
it("duplicates and value shapes are errors", () => {
  const found = issues(`version: 1
version: 1
default_currency: PLN
quote: "''"
columns:
  trade_date: Date
  trade_date: Other
  type: [a, b]
  cash_amount: ""
types:
  Kupno: buy
  kupno: sell
`);
  const messages = new Set(found.map((issue) => `${issue.path}|${issue.message}`));
  for (const [path, message] of [
    ["version", "Duplicate key"],
    ["quote", "Must be exactly one character"],
    ["columns.trade_date", "Duplicate field"],
    ["columns.type", "Must be a single value"],
    ["columns.cash_amount", "Header text must not be empty"],
    ["types.kupno", "Duplicate broker type"],
  ]) {
    expect(messages.has(`${path}|${message}`), `${path}: ${message}`).toBe(true);
  }
});

// test_yaml_syntax_errors_and_non_map_documents
it("YAML syntax errors and non-map documents", () => {
  const syntax = issues("version: 1\ncolumns: [unclosed");
  expect(syntax).toHaveLength(1);
  expect(syntax[0]?.line).not.toBeNull();
  expect(issues("- just\n- a list")[0]?.message).toBe("The mapping must be a YAML map");
  expect(issues("")[0]?.message).toBe("The mapping must be a YAML map");
  // pytest.raises(CsvMappingError, match="columns"): re.search over str(error)
  expect(csvMappingErrorText(issues("version: 1"))).toMatch(/columns/u);
});

// test_oversized_mapping_is_rejected
it("oversized mapping is rejected", () => {
  expect(issues("#".repeat(300_000))[0]?.message).toContain("too large");
});
