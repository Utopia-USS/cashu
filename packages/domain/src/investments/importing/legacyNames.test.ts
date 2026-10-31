import { expect, it } from "vitest";
import { Decimal } from "../../decimal.js";
import {
  CANONICAL_BROKER_ID,
  CanonicalImporter,
  canonicalImporterId,
  LEGACY_BROKER_ID,
  LEGACY_FORMAT,
} from "./canonical/index.js";
import {
  effectiveBrokerId,
  equivalentNamespaces,
  hasBlockingWarnings,
  importParseResult,
  namespaceOf,
} from "./contract.js";
import { enc } from "./testing/support.js";

// Translation of tests/investments/importing/test_imp_legacy_names.py (F11: the format and alias
// namespace from before the rename (legacy name: "finanse") keep working). The alias resolution and dedup hash tests
// need the resolver and dedup (scope S17c) and are listed there.
const RECORD = {
  record: "txn",
  date: "2026-10-01",
  type: "deposit",
  currency: "PLN",
  gross_amount: "100.00",
  external_ref: "R1",
};

const legacyFile = (format: string) => ({
  name: "old.json",
  content: enc(JSON.stringify({ format, format_version: 1, records: [RECORD] })),
});

// test_a_document_with_the_legacy_format_id_parses
it("a document with the legacy format id parses", () => {
  const importer = new CanonicalImporter();
  const old = legacyFile(LEGACY_FORMAT);
  expect(importer.canParse(old)).toBe(true);
  const result = importer.parse(old);
  expect(hasBlockingWarnings(result)).toBe(false);
  expect(result.txns).toHaveLength(1);
  expect(result.txns[0]?.grossAmount.eq(Decimal.parse("100"))).toBe(true);
});

// test_legacy_source_and_importer_ids_read_as_the_new_ones
it("legacy source and importer ids read as the new ones", () => {
  const importer = new CanonicalImporter();
  expect([importer.brokerId, CANONICAL_BROKER_ID]).toEqual(["cashu", "cashu"]);
  expect(effectiveBrokerId(importer, importParseResult({ source: LEGACY_BROKER_ID }))).toBe(
    "cashu",
  );
  expect(effectiveBrokerId(importer, importParseResult({ source: "xtb" }))).toBe("xtb");
  expect(canonicalImporterId(LEGACY_BROKER_ID)).toBe("cashu");
  expect(canonicalImporterId("generic_csv")).toBe("generic_csv");
  expect(canonicalImporterId(null)).toBeNull();
});

// Not in the Python file: the namespace helpers the alias lookups (S17c) are built on.
it("the legacy namespace is the same namespace as the current one", () => {
  // legacy name
  expect(namespaceOf("finanse")).toBe("cashu");
  expect(namespaceOf("xtb")).toBe("xtb");
  expect(equivalentNamespaces("cashu")).toEqual(["cashu", "finanse"]); // legacy name
  expect(equivalentNamespaces("finanse")).toEqual(["cashu", "finanse"]); // legacy name
  expect(equivalentNamespaces("xtb")).toEqual(["xtb"]);
});
