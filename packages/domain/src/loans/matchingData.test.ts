/// <reference types="node" />
// The Polish installment phrases (matching data) and the loans / assets literals are byte-identical to
// the live Python objects: `parity/python/vectors_loans_assets.py` reads INSTALLMENT_PHRASES,
// LOANS_CATEGORY, LOAN_TYPES, MANUAL_PREFIXES, NOTE_MAX and DAYS_PER_YEAR from the modules; this test
// rebuilds the same object from the TS constants and compares it and its sha256.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DAYS_PER_YEAR, MANUAL_PREFIXES, NOTE_MAX } from "../assets/index.js";
import { loadVectors } from "../testing/vectors.js";
import { INSTALLMENT_PHRASES, LOANS_CATEGORY } from "./patterns.js";
import { LOAN_TYPES } from "./service.js";

/** `json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))`. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const [, python, sha] = loadVectors("loans-assets-matching-data").rows[0] as [
  string,
  Record<string, unknown>,
  string,
];

describe("Polish installment phrases and module literals: byte-identical to the live Python source", () => {
  it("phrases, categories, types, prefixes, limits and their sha256", () => {
    const ts = {
      installment_phrases: INSTALLMENT_PHRASES.map((p) => [...p]),
      loans_category: LOANS_CATEGORY,
      loan_types: [...LOAN_TYPES],
      manual_prefixes: [...MANUAL_PREFIXES],
      note_max: NOTE_MAX,
      days_per_year: DAYS_PER_YEAR,
    };
    expect(ts).toEqual(python);
    expect(createHash("sha256").update(stableStringify(ts), "utf8").digest("hex")).toBe(sha);
    for (const [phrase] of INSTALLMENT_PHRASES) expect(phrase.normalize("NFC")).toBe(phrase);
  });
});
