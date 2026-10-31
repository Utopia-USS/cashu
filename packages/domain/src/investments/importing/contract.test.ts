import { expect, it } from "vitest";
import { Currencies, TxnType } from "../domain/index.js";
import { CanonicalImporter } from "./canonical/index.js";
import {
  type BrokerImporter,
  effectiveBrokerId,
  hasBlockingWarnings,
  IMPORT_WARNING_KINDS,
  type ImportFile,
  type ImportParseResult,
  ImportWarningKind,
  importFileExtension,
  importParseResult,
  importWarning,
  instrumentNamed,
  type ParsedCorporateAction,
  parsedDelisting,
  parsedRename,
  warningCode,
  warningText,
} from "./contract.js";
import { DuplicateImporterError, ImporterRegistry } from "./registry.js";
import { csvFile, d, day, parsedTxnOf } from "./testing/support.js";

// Translation of tests/investments/importing/test_imp_contract.py (contract types and the registry).
// Not here: exchange hints, the market table, crypto symbols, split_broker_symbol, US venues, the
// ticker:MIC form and Hong Kong padding (exchanges.py, scope S17b), and the default registry with the
// generic CSV importer (S17b).
const file = (name: string): ImportFile => ({ name, content: new Uint8Array() });

// test_import_file_extension
it("import file extension", () => {
  expect(importFileExtension(file("Export.CSV"))).toBe("csv");
  expect(importFileExtension(file("archive.tar.gz"))).toBe("gz");
  expect(importFileExtension(file("noext"))).toBe("");
  expect(importFileExtension(file(".hidden"))).toBe("");
});

// test_parse_result_converts_lists_and_reports_blocking
it("parse result copies sequences and reports blocking", () => {
  const txn = parsedTxnOf(TxnType.BUY, { price: "10" });
  const list = [txn];
  const result = importParseResult({
    txns: list,
    warnings: [
      importWarning({ message: "a" }),
      importWarning({ message: "b", row: 3, blocking: true }),
    ],
  });
  list.length = 0;
  expect(result.txns).toHaveLength(1);
  expect(Object.isFrozen(result.warnings)).toBe(true);
  expect(hasBlockingWarnings(result)).toBe(true);
  expect(warningText(result.warnings[1] as never)).toBe("row 3: b (blocking)");
  expect(warningText(result.warnings[0] as never)).toBe("a");
  expect(hasBlockingWarnings(importParseResult())).toBe(false);
  expect(() => {
    (result as { accountHint: string | null }).accountHint = "x";
  }).toThrow(TypeError);
});

// test_parsed_txn_is_hashable_and_raw_row_is_not_part_of_the_hash
it("parsed txn defaults and instrument naming (hashing is Python-only)", () => {
  const txn = parsedTxnOf(TxnType.BUY);
  expect(txn.fee.isZero() && txn.tax.isZero()).toBe(true);
  expect(instrumentNamed(txn)).toBe(true);
  expect(instrumentNamed(parsedTxnOf(TxnType.DEPOSIT, { symbol: "  " }))).toBe(false);
  expect(Object.isFrozen(txn)).toBe(true);
});

// test_corporate_actions_are_one_family
it("corporate actions are one family", () => {
  const rename = parsedRename({ date: day("2026-02-01"), oldSymbol: "ABC", newSymbol: "ABCN" });
  const delisting = parsedDelisting({ date: day("2026-02-02"), symbol: "ZZZ", frozen: true });
  const family: ParsedCorporateAction[] = [rename, delisting];
  expect(family.map((action) => action.kind)).toEqual(["rename", "delisting"]);
  expect([rename.rowIndex, delisting.frozen]).toEqual([null, true]);
});

// test_importers_satisfy_the_protocol (the generic CSV importer: S17b)
it("importers satisfy the protocol", () => {
  const importer: BrokerImporter = new CanonicalImporter();
  expect(importer.brokerId).toBe("cashu");
});

class Fake implements BrokerImporter {
  readonly displayName: string;
  readonly version = 1;
  constructor(
    readonly brokerId: string,
    private readonly accepts = true,
    private readonly explode = false,
  ) {
    this.displayName = brokerId.toUpperCase();
  }

  canParse(): boolean {
    if (this.explode) throw new Error("sniff failed");
    return this.accepts;
  }

  parse(): ImportParseResult {
    return importParseResult();
  }
}

// test_registry_register_get_detect
it("registry register, get, detect", () => {
  const [first, second, broken, other] = [
    new Fake("a"),
    new Fake("b"),
    new Fake("c", true, true),
    new Fake("d", false),
  ];
  const registry = new ImporterRegistry([first, broken, second, other]);
  expect(registry.importers).toEqual([first, broken, second, other]);
  expect(registry.get("b")).toBe(second);
  expect(registry.get("zzz")).toBeUndefined();
  expect(registry.has("a") && registry.size === 4).toBe(true);
  expect(registry.detect(csvFile("x")), "throwing sniffs are no match").toEqual([first, second]);
  expect(() => registry.register(new Fake("a"))).toThrow(DuplicateImporterError);
  expect(() => registry.register(new Fake("a"))).toThrow(
    "An importer with broker id 'a' is already registered",
  );
});

// test_effective_broker_id_prefers_the_file_source
it("effective broker id prefers the file source", () => {
  const importer = new CanonicalImporter();
  expect(effectiveBrokerId(importer, importParseResult())).toBe("cashu");
  expect(effectiveBrokerId(importer, importParseResult({ source: "examplebroker" }))).toBe(
    "examplebroker",
  );
});

// test_warning_values
it("warning values", () => {
  expect(importWarning({ message: "m" })).toEqual(
    importWarning({ message: "m", row: null, blocking: false }),
  );
  expect(d("1").eq(d("1.0"))).toBe(true);
});

// test_warning_kinds
it("warning kinds", () => {
  expect(importWarning({ message: "m" }).kind).toBe(ImportWarningKind.OTHER);
  expect(ImportWarningKind.OTHER).toBe("other");
  const warning = importWarning({ message: "m", kind: ImportWarningKind.FX_MISSING });
  expect(warning.kind).toBe("fx_missing");
  expect(warningCode(warning)).toBe("import.fx_missing");
  expect(IMPORT_WARNING_KINDS.includes("unmapped_type" as ImportWarningKind)).toBe(true);
  for (const kind of ["unknown_split_ratio", "history_gap_hint", "fx_missing"]) {
    expect(IMPORT_WARNING_KINDS as readonly string[]).toContain(kind);
  }
  expect(warningCode(importWarning({ message: "m", kind: "" }))).toBe("import.other");
});

// A reminder that the contract uses the domain currency type (no raw strings).
it("currencies come from the domain", () => {
  expect(parsedTxnOf(TxnType.BUY, { currency: Currencies.PLN }).currency).toBe("PLN");
});
