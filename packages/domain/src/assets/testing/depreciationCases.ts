/** Test-only: replay of the `depreciation.value` vectors (default and exhaustive tiers share it). */

import { D } from "../../decimal.js";
import { type Mismatches, outcome } from "../../testing/vectors.js";
import { DepreciationRateError, depreciatedValue } from "../depreciation.js";

/** `[price, purchase_date, rate, as_of, floor | null, value | {error}]`. */
export type DepreciationCase = [
  string,
  string,
  string,
  string,
  string | null,
  string | { error: string },
];

/** Python fails with TypeError where the port throws `DepreciationRateError` (a complex power). */
function errorName(error: unknown): string | null {
  return error instanceof DepreciationRateError ? "TypeError" : null;
}

export function checkDepreciationCases(
  m: Mismatches,
  cases: readonly DepreciationCase[],
  offset: number,
): void {
  for (const [i, [price, purchase, rate, asOf, floor, want]] of cases.entries()) {
    const got = outcome(
      () =>
        depreciatedValue(
          D(price),
          purchase,
          D(rate),
          asOf,
          floor === null ? null : D(floor),
        ).toString(),
      errorName,
    );
    m.check(`case ${offset + i}`, got, want);
  }
}
