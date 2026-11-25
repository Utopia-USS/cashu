import { describe, expect, it } from "vitest";
import { normalizeText, pySplit, pyStrip, pyUpper } from "./text.js";

// normalize_text is the key every Polish keyword rule, merchant and person name is matched on.
describe("normalizeText", () => {
  it("upper-cases, strips Polish diacritics (incl. ł), collapses whitespace", () => {
    expect(normalizeText("  Zażółć \t gęślą  JAŹŃ ")).toBe("ZAZOLC GESLA JAZN");
    expect(normalizeText("Łódź Żabka　nr 7")).toBe("LODZ ZABKA NR 7");
    expect(normalizeText("ﬁ Ⅻ ①")).toBe("FI XII 1");
    expect(normalizeText("x\u001cy")).toBe("X Y");
  });

  it("is empty for null, undefined and blank text", () => {
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
    expect(normalizeText(" \t\n")).toBe("");
  });
});

describe("Python whitespace and case", () => {
  it("strip / split treat Python's isspace set (incl. \\x1c-\\x1f) as whitespace, not ZWSP", () => {
    expect(pyStrip("\u001c a \u001f ")).toBe("a");
    expect(pyStrip("​a​")).toBe("​a​");
    expect(pySplit(" a b\u001ec  ")).toEqual(["a", "b", "c"]);
  });

  it("upper uses full case mapping", () => {
    expect(pyUpper("straße ŉ")).toBe("STRASSE ʼN");
  });
});
