import { describe, expect, it } from "vitest";
import { loadVectors } from "../testing/vectors.js";
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

// Person detection gates what may reach a cloud LLM or the MCP agent (privacy).
describe("person names", () => {
  it("the Polish word lists are pinned (matching data)", () => {
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

  it("looksLikePerson spots people and leaves businesses and institutions alone", () => {
    expect(looksLikePerson("JAN TESTOWY")).toBe(true);
    expect(looksLikePerson("MARIA-ANNA x\u0301 00-001 TESTOWA")).toBe(true);
    expect(looksLikePerson("Zoë DOM BAR 1234 A1 SP. Z O.O.")).toBe(false);
    expect(looksLikePerson("- WARSZAWA ZUS APTEKA")).toBe(false);
    expect(looksLikePerson("STUDIO Łucja józef ANNA A1 Ørjan")).toBe(false);
    expect(looksLikePerson(null)).toBe(false);
  });

  it("fold strips diacritics (ł, ß, Ø too); personPart stops at digits and address words", () => {
    expect(foldName("TESTOWA ANNA Straße ĐURIC Łucja")).toBe("TESTOWA ANNA STRASSE DURIC LUCJA");
    expect(normalizeMerchantName("Zoë SP. Z O.O.")).toBe("ZOE SP Z OO");
    expect(personPart("MARIA-ANNA x\u0301 00-001 TESTOWA")).toEqual(["MARIA", "ANNA", "X"]);
    expect(personPart("A. A. AL. TESTOWA 12")).toEqual(["A", "A"]);
    expect(personPart("1234 Łucja STUDIO")).toEqual([]);
  });
});
