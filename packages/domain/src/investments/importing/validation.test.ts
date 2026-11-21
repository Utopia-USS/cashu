import { describe, expect, it } from "vitest";
import {
  type BrokerImporter,
  type ImportFile,
  ImportWarningKind,
  importParseResult,
  importWarning,
} from "./contract.js";
import { csvMappingFromYaml } from "./csvMapping.js";
import { GenericCsvImporter } from "./genericCsv.js";
import {
  csvFile,
  enc,
  plExportUtf8Bom,
  plMappingYaml,
  SIMPLE_HEADER,
  simpleMapping,
  specBlocks,
} from "./testing/support.js";
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

// Translation of tests/investments/importing/test_imp_validation.py, every test. The TS boundary is
// bytes plus an importer: Python's `validate_import_file(path, mapping=...)` reads the data file and
// the mapping YAML and builds the `GenericCsvImporter` itself; here the test does that part (what the
// caller does) and hands `validateImportFile` an `ImportFile` and the importer.
// Not translatable: `pytest.raises(OSError)` for a missing data file (the domain never touches the
// file system; reading is the caller's job) and the monkeypatched `MAX_FILE_BYTES` (the limit is the
// `maxBytes` parameter instead).
const spec = (language: string, needle: string) =>
  specBlocks(language).find((block) => block.includes(needle)) as string;

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

it("unrecognized file", () => {
  const report = validateImportFile(csvFile("Date;Type;Amount\n", "export.csv"));
  expect(reportOk(report)).toBe(false);
  expect(report.importerId).toBeNull();
  expect(report.errors).toHaveLength(1);
  const [error] = report.errors;
  expect(error?.kind).toBe(ImportWarningKind.IMPORTER_ERROR);
  expect(error?.message).toContain("docs/import-format.md");
});

it("generic CSV with a mapping file", () => {
  const data: ImportFile = { name: "pl_broker.csv", content: plExportUtf8Bom() };
  // validate_import_file(data, mapping=path): the caller reads the YAML and builds the importer
  const parsed = csvMappingFromYaml(plMappingYaml());
  if (!parsed.ok) throw new Error("fixture mapping is invalid");
  const report = validateImportFile(data, new GenericCsvImporter(parsed.mapping));
  expect(reportOk(report)).toBe(true);
  expect(report.importerId).toBe("generic_csv");
  expect(reportTxnCount(report)).toBe(7);
  expect(report.warnings.map((w) => w.kind)).toEqual([ImportWarningKind.IGNORED_ROW]);
  // pytest.raises(CsvMappingError): an invalid mapping never reaches validation
  expect(csvMappingFromYaml("version: 1\n").ok).toBe(false);
  // pytest.raises(OSError) for a missing file: not translatable (see the header)
});

it("generic CSV gets the semantic checks", () => {
  const content = `${SIMPLE_HEADER}\na,2026-01-05,buy,,,,1,10,PLN,0,-10\nb,2026-01-05,split,PKN,,GPW,,,PLN,,\n`;
  const report = validateImport(
    { name: "x.csv", content: enc(content) },
    new GenericCsvImporter(simpleMapping()),
  );
  const kinds = new Set(report.errors.map((issue) => issue.kind));
  expect(kinds.has(ImportWarningKind.MISSING_INSTRUMENT)).toBe(true);
  expect(kinds.has(ImportWarningKind.UNKNOWN_SPLIT_RATIO)).toBe(true);
});

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
