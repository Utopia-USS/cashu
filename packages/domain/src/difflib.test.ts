import { describe, expect, it } from "vitest";
import { getCloseMatches, sequenceRatio } from "./difflib.js";

// Python difflib: the canonical budget import (budget/ingestion/canonical/validate.ts) and the
// investments importer (investments/importing/didYouMean.ts) suggest a column name with it.
const COLUMNS = [
  "booking_date",
  "amount",
  "currency",
  "description",
  "counterparty_iban",
  "source",
];

describe("difflib", () => {
  it("ratio is 2*M/T like SequenceMatcher", () => {
    expect(sequenceRatio("abcd", "bcde")).toBe(0.75);
    expect(sequenceRatio("", "abc")).toBe(0);
    expect(sequenceRatio("same", "same")).toBe(1);
  });

  it("suggests the misspelled column and nothing below the cutoff", () => {
    expect(getCloseMatches("descriptino", COLUMNS, 1, 0.75)).toEqual(["description"]);
    expect(getCloseMatches("counterparty_bian", COLUMNS, 1, 0.75)).toEqual(["counterparty_iban"]);
    expect(getCloseMatches("currrncy", COLUMNS, 1, 0.75)).toEqual(["currency"]);
    expect(getCloseMatches("soucr_", COLUMNS, 1, 0.75)).toEqual([]);
    expect(getCloseMatches("", COLUMNS, 1, 0.75)).toEqual([]);
  });

  it("returns the best n matches, best first", () => {
    expect(getCloseMatches("appel", ["ape", "apple", "peach", "puppy"], 3, 0.6)).toEqual([
      "apple",
      "ape",
    ]);
  });
});
