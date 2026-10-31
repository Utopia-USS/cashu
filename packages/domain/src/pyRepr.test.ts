import { expect, it } from "vitest";
import { pyReprStr } from "./pyRepr.js";
import { loadVectors } from "./testing/vectors.js";

// repr(str) against Python 3.14 (parity/python/vectors_inv_importing.py, `inv-importing-repr`); the
// sweep over every code point is `pyRepr.codepoints.exhaustive.test.ts`.
it("pyReprStr equals Python's repr for quotes, escapes and non-printable characters", () => {
  const samples = loadVectors("inv-importing-repr").rows.filter((r) => r[0] === "samples") as [
    string,
    string,
    string,
  ][];
  expect(samples.length).toBeGreaterThan(10);
  for (const [, text, want] of samples) expect(pyReprStr(text), JSON.stringify(text)).toBe(want);
});

it("pyReprStr picks the quote like Python", () => {
  expect(pyReprStr("it's")).toBe('"it\'s"');
  expect(pyReprStr("both ' and \"")).toBe("'both \\' and \"'");
  expect(pyReprStr("")).toBe("''");
});
