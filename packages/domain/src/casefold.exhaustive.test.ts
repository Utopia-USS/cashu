import { describe, expect, it } from "vitest";
import { pyCasefold } from "./casefold.js";
import { PLANES } from "./testing/vectors.js";

// Casefolding whole blocks of code points equals casefolding each code point alone (exhaustive tier,
// see references/testing.md): pins the whole-string fast path of `pyCasefold` against the table path.
function perCodePoint(s: string): string {
  return Array.from(s, (ch) => pyCasefold(ch)).join("");
}

describe("pyCasefold over every code point", () => {
  it.each(PLANES)(
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
