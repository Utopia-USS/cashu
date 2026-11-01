import { describe, expect, it } from "vitest";
import { amountLiterals, scrubAmountLiterals } from "./exprLiterals.js";
import { nativeExprDeps } from "./exprNative.js";
import type { ExprUnit } from "./exprTypes.js";
import { exprDepsFromVectors, loadVectors } from "./testing/vectors.js";

describe("native expression privacy adapter", () => {
  it("matches independent Python trees and catalog units without changing the privacy policy", () => {
    const oracle = exprDepsFromVectors();
    const vectors = loadVectors<{
      units: Record<string, ExprUnit | null>;
      rows: { source: string }[];
    }>("expressions");
    for (const { source } of vectors.rows) {
      expect(nativeExprDeps.parse(source)).toEqual(oracle.parse(source));
      for (const privatePrices of [false, true]) {
        expect(amountLiterals(source, undefined, { privatePrices })).toEqual(
          amountLiterals(source, oracle, { privatePrices }),
        );
        expect(scrubAmountLiterals(source, undefined, { privatePrices })).toBe(
          scrubAmountLiterals(source, oracle, { privatePrices }),
        );
      }
    }
    for (const [name, unit] of Object.entries(vectors.units)) {
      expect(nativeExprDeps.metricUnit(name)).toBe(unit);
    }
    expect(nativeExprDeps.metricUnit("unknown_synthetic_metric")).toBeNull();
  });
});
