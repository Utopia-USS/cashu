// Pinned redaction cases found by the property search (property.fuzz.exhaustive.test.ts, exhaustive
// tier): each stays here as a fast, named regression.
import { describe, expect, it } from "vitest";
import * as L from "./labels.js";
import { leakCheck, Redactor } from "./redactor.js";

describe("closed gaps (S37fix: a number one space before a dotted card / account number)", () => {
  // These leaked 12 digits in both modes before S37fix (the long-digit rule took the first part, the
  // dotted rule saw three groups). The whole run is one identifier now; Python gives the same text.
  it.each([
    ["konto 1234567 7942.8841.3456.5750 dla", "konto [number] dla"],
    ["XY12345678 8771.5052.4115.1224 12.5%", "[iban]%"], // one run from the country-code-like XY
    ["U1234567 5846.8915.7764.4910 przelew", "U[number] przelew"],
  ])("%s", (input, expected) => {
    for (const strict of [true, false]) {
      const out = new Redactor({ privacy: strict ? "strict" : "amounts" }).apply({
        n: L.text(input),
      });
      expect((out as { n: string }).n).toBe(expected);
      leakCheck(out, { strict });
    }
  });
});
