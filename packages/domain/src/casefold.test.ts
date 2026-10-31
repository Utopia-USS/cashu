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

  it.each(Array.from({ length: 0x110000 / 0x10000 }, (_, plane) => plane))(
    "folds every code point block of plane %i with its neighbours like each code point alone",
    (plane) => {
      for (let block = plane * 0x10000; block < (plane + 1) * 0x10000; block += 0x400) {
        let text = "";
        for (let cp = block; cp < block + 0x400; cp++) {
          if (cp >= 0xd800 && cp <= 0xdfff) continue;
          text += String.fromCodePoint(cp);
        }
        expect(pyCasefold(text), `block ${block.toString(16)}`).toBe(perCodePoint(text));
      }
    },
  );
});
