// Every random source of the retired Python vectors_inv_rules_expr.py (inv-rules-expr-random: token soups
// with non-ASCII, astral and control characters, mutations of valid expressions, random well-formed and
// type-correct trees, nesting around MAX_DEPTH) against Python's tokenize and compile_expression in
// every scope (exhaustive tier, see references/testing.md "Test tiers").

import { describe, it } from "vitest";
import { expectAll, loadVectors, Mismatches } from "../../../testing/vectors.js";
import { compileAllScopes, tokensOut } from "./testing/vectorOut.js";

const SLICE = 500;

describe("inv-rules-expr-random vectors", () => {
  const rows = loadVectors("inv-rules-expr-random").rows;
  const starts = Array.from({ length: Math.ceil(rows.length / SLICE) }, (_, i) => i * SLICE);
  it.each(starts)("rows %i.. : tokens and compile outcomes equal Python", (start) => {
    const m = new Mismatches();
    for (const [i, row] of rows.slice(start, start + SLICE).entries()) {
      const source = row[1] as string;
      const actual = row[0] === "tokens" ? tokensOut(source) : compileAllScopes(source);
      m.check(`#${start + i} ${row[0]} ${JSON.stringify(source.slice(0, 60))}`, actual, row[2]);
    }
    expectAll(m);
  });
});
