import { describe, expect, it } from "vitest";
import { Decimal, DecimalError, floatRepr } from "./decimal.js";
import { CurrencyError, dividedBy, ratio, toCurrency } from "./money.js";
import { loadVectors, Mismatches, outcome } from "./testing/vectors.js";

const errorName = (error: unknown) =>
  error instanceof DecimalError
    ? error.signal
    : error instanceof CurrencyError
      ? "ValueError"
      : null;
const run = <T>(fn: () => T) => outcome(fn, errorName);

describe("money vectors (parity/python/vectors.py)", () => {
  it("divided_by, ratio, Currency", () => {
    const m = new Mismatches();
    for (const row of loadVectors("money").rows) {
      const label = JSON.stringify(row.slice(0, -1));
      const expected = row[row.length - 1];
      if (row[0] === "divided_by") {
        const [, a, b, scale] = row as [string, string, string, number];
        m.check(
          label,
          run(() => dividedBy(Decimal.parse(a), Decimal.parse(b), scale).toString()),
          expected,
        );
      } else if (row[0] === "ratio") {
        const [, a, b] = row as [string, string, string];
        const got = run(() => {
          const r = ratio(Decimal.parse(a), Decimal.parse(b));
          return r === null ? null : floatRepr(r);
        });
        m.check(label, got, expected);
      } else {
        m.check(
          label,
          run(() => toCurrency(row[1] as string)),
          expected,
        );
      }
    }
    expect(m.checked).toBeGreaterThan(5000);
    expect(m.items, m.report()).toEqual([]);
  });
});
