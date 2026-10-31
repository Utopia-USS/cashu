import { describe, expect, it } from "vitest";
import { TxnType } from "../domain/index.js";
import {
  type BrokerImporter,
  type ImportFile,
  ImportWarningKind,
  importParseResult,
  importWarning,
  parsedTxn,
} from "./contract.js";
import { csvFile, enc, parsedTxnOf, specBlocks } from "./testing/support.js";
import {
  MAX_FILE_BYTES,
  reportCorporateActionCount,
  reportOk,
  reportPositionCount,
  reportSummary,
  reportTxnCount,
  validateImport,
  validateImportFile,
} from "./validation.js";

// Translation of tests/investments/importing/test_imp_validation.py. The tests that go through a
// mapping file or the file system (generic CSV, `OSError`, `CsvMappingError`) are the caller's or scope
// S17b's: the domain gets bytes and an importer.
const spec = (language: string, needle: string) =>
  specBlocks(language).find((block) => block.includes(needle)) as string;

// test_valid_canonical_csv_and_json
it("valid canonical CSV and JSON", () => {
  const report = validateImportFile(csvFile(spec("csv", "position"), "converted.csv"));
  expect(reportOk(report)).toBe(true);
  expect([
    reportTxnCount(report),
    reportPositionCount(report),
    reportCorporateActionCount(report),
  ]).toEqual([11, 3, 2]);
  expect(report.importerId).toBe("cashu");
  const summary = reportSummary(report);
  expect(summary.startsWith("converted.csv: OK (cashu)")).toBe(true);
  expect(summary).toContain("transactions: 11, positions: 3, corporate actions: 2");
  expect(
    reportOk(validateImportFile(csvFile(spec("json", '"records": [\n'), "converted.json"))),
  ).toBe(true);
});

// test_invalid_canonical_file_lists_every_problem
it("invalid canonical file lists every problem", () => {
  const report = validateImportFile(
    csvFile(
      "format_version,record,date,type,currency,cash_amount,quantity\n" +
        "1,txn,2026-01-05,deposit,PLN,-5,\n" +
        "1,txn,2026-13-01,buy,PLN,,1\n" +
        "1,txn,2026-01-06,tax,PLN,3,\n",
      "broken.csv",
    ),
  );
  expect(reportOk(report)).toBe(false);
  expect(new Set(report.errors.map((issue) => issue.row))).toEqual(new Set([0, 1]));
  expect(report.warnings.map((w) => w.kind)).toEqual([ImportWarningKind.CASH_SIGN]);
  const text = reportSummary(report);
  expect(text).toContain("INVALID");
  expect(text).toContain("error   row 0: cash_amount: -5 must be >= 0 for deposit");
  expect(text).toContain("warning row 2: cash_amount: 3 is positive for tax");
});

// test_unrecognized_file
it("unrecognized file", () => {
  const report = validateImportFile(csvFile("Date;Type;Amount\n", "export.csv"));
  expect(reportOk(report)).toBe(false);
  expect(report.importerId).toBeNull();
  expect(report.errors).toHaveLength(1);
  const [error] = report.errors;
  expect(error?.kind).toBe(ImportWarningKind.IMPORTER_ERROR);
  expect(error?.message).toContain("docs/import-format.md");
});

// test_generic_csv_gets_the_semantic_checks (with the generic importer: scope S17b; here an importer
// that returns rows without an instrument and a split without a ratio)
it("every importer's rows get the semantic checks", () => {
  const rowsOnly: BrokerImporter = {
    brokerId: "fake",
    displayName: "Fake",
    version: 1,
    canParse: () => true,
    parse: () =>
      importParseResult({
        txns: [
          parsedTxnOf(TxnType.BUY, { symbol: null, row: 0 }),
          parsedTxn({ ...parsedTxnOf(TxnType.SPLIT, { row: 1, symbol: "PKN" }), splitRatio: null }),
        ],
      }),
  };
  const report = validateImport(csvFile("x"), rowsOnly);
  expect(new Set(report.errors.map((issue) => issue.kind))).toEqual(
    new Set([ImportWarningKind.MISSING_INSTRUMENT, ImportWarningKind.UNKNOWN_SPLIT_RATIO]),
  );
  expect(reportOk(report)).toBe(false);
});

// test_too_large_and_crashing_importers
describe("too large and crashing importers", () => {
  it("refuses a file over the limit unread", () => {
    const report = validateImportFile(
      csvFile("format_version,record,date\n", "big.csv"),
      undefined,
      5,
    );
    expect(reportOk(report)).toBe(false);
    expect(report.errors[0]?.message).toContain("too large");
    expect(report.errors[0]?.message).toBe("File is too large (27 bytes, max 5)");
    expect(MAX_FILE_BYTES).toBe(64 * 1024 * 1024);
  });

  it("reports a crashing importer instead of throwing", () => {
    const crashing: BrokerImporter = {
      brokerId: "crash",
      displayName: "Crash",
      version: 1,
      canParse: () => true,
      parse: (): never => {
        throw new Error("boom");
      },
    };
    const crashed = validateImport({ name: "x.csv", content: new Uint8Array() }, crashing);
    expect(reportOk(crashed)).toBe(false);
    expect(crashed.errors[0]?.message).toContain("Importer crash failed: boom");
  });
});

// Not in the Python file: a sniff that throws is "not recognized", and equal errors are reported once.
describe("robustness", () => {
  const fake = (over: Partial<BrokerImporter>): BrokerImporter => ({
    brokerId: "fake",
    displayName: "Fake",
    version: 1,
    canParse: () => true,
    parse: () => importParseResult(),
    ...over,
  });
  const file: ImportFile = { name: "x.csv", content: enc("") };

  it("treats a throwing sniff as not recognized", () => {
    const report = validateImport(
      file,
      fake({
        canParse: () => {
          throw new Error("sniff");
        },
      }),
    );
    expect(report.errors[0]?.message).toContain(
      "the mapped columns or the extension do not match the file",
    );
  });

  it("lists a repeated blocking warning once", () => {
    const warning = importWarning({ message: "same", row: 1, blocking: true });
    const report = validateImport(
      file,
      fake({ parse: () => importParseResult({ warnings: [warning, warning] }) }),
    );
    expect(report.errors).toHaveLength(1);
  });
});
