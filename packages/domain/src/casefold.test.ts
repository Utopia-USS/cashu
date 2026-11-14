import { describe, expect, it } from "vitest";
import { pyCasefold } from "./casefold.js";

/** Casefolding each code point alone: no context, the definition of `str.casefold()` here. */
function perCodePoint(s: string): string {
  return Array.from(s, (ch) => pyCasefold(ch)).join("");
}

describe("pyCasefold", () => {
  it("folds a whole string like each code point alone (no final sigma, no context)", () => {
    const texts = [
      "",
      "Hello World",
      "ZAŻÓŁĆ GĘŚLĄ JAŹŃ",
      "STRASSE Straße ẞ",
      "ΟΔΥΣΣΕΥΣ ΑΣ Σ ΑΣ. ΑΣΑ",
      "İstanbul ISTANBUL ıi",
      "ǅ ǈ ǋ ǲ ᾈ ﬃ ﬆ ŉ ǰ ΐ",
      "Cherokee Ꭰᏸꭰ",
      "\ud800 lone \udc00 surrogates 😀 PAIR 𐐀",
      "Áͅ Σ́ Σ-Σ",
    ];
    for (const text of texts)
      expect(pyCasefold(text), JSON.stringify(text)).toBe(perCodePoint(text));
  });
});
