import { describe, expect, it } from "vitest";
import { loadVectors, Mismatches } from "../testing/vectors.js";
import {
  ADDRESS_WORDS,
  AMBIGUOUS_MARKERS,
  BUSINESS_MARKERS,
  FOLD_EXTRA,
  foldName,
  looksLikePerson,
  normalizeMerchantName,
  personPart,
} from "./personNames.js";

const rows = loadVectors("budget-person").rows;

describe("person names vectors (core/mcp/names.py via vectors_budget.py)", () => {
  it("the word lists are Python's", () => {
    const [, business, ambiguous, address, extra] = rows[0] as [
      string,
      string[],
      string[],
      string[],
      unknown,
    ];
    expect([...BUSINESS_MARKERS].sort()).toEqual(business);
    expect([...AMBIGUOUS_MARKERS].sort()).toEqual(ambiguous);
    expect([...ADDRESS_WORDS].sort()).toEqual(address);
    expect(FOLD_EXTRA).toEqual(extra);
  });

  it("fold, normalize, person_part and looks_like_person equal Python", () => {
    const m = new Mismatches();
    for (const row of rows.filter((r) => r[0] === "name")) {
      const [, text, fold, norm, part, person] = row as [
        string,
        string | null,
        string,
        string,
        string[],
        boolean,
      ];
      m.check(`fold ${text}`, foldName(text ?? ""), fold);
      m.check(`normalize ${text}`, normalizeMerchantName(text), norm);
      m.check(`person_part ${text}`, personPart(text), part);
      m.check(`looks_like_person ${text}`, looksLikePerson(text), person);
    }
    expect(m.items, m.report()).toEqual([]);
    expect(m.checked).toBe(4 * (rows.length - 1));
  });
});
