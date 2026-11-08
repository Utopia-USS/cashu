// The expression compiler against Python `rules/expr` (vectors from
// the retired Python vectors_inv_rules_expr.py, inv-rules-expr-cases: the catalog, names per scope, and
// tokens + compile outcomes in every scope for every input of the two oracle test files, the security
// tests' generated sources, hand edge cases and the catalog templates). The random corpus replays in
// expr.vectors.exhaustive.test.ts.

import { describe, expect, it } from "vitest";
import { expectAll, loadVectors, Mismatches } from "../../../testing/vectors.js";
import { namesInScope } from "./catalog.js";
import { SCOPES } from "./catalogTypes.js";
import { catalogOut, compileAllScopes, compileOut, tokensOut } from "./testing/vectorOut.js";

const rows = loadVectors("inv-rules-expr-cases").rows;
const SLICE = 400;

const label = (source: unknown): string => JSON.stringify(String(source).slice(0, 60));

describe("inv-rules-expr-cases vectors", () => {
  it("the catalog and names per scope equal Python", () => {
    const m = new Mismatches();
    for (const row of rows) {
      if (row[0] === "catalog") m.check("catalog", catalogOut(), row[1]);
      if (row[0] === "names") {
        const scope = SCOPES.find((s) => s === row[1]);
        expect(scope).toBeDefined();
        if (scope !== undefined) m.check(`names ${scope}`, namesInScope(scope), row[2]);
      }
    }
    expect(m.checked).toBe(1 + SCOPES.length);
    expectAll(m);
  });

  const sliced = rows.filter((row) => row[0] === "tokens" || row[0] === "compile");
  const starts = Array.from({ length: Math.ceil(sliced.length / SLICE) }, (_, i) => i * SLICE);
  it.each(starts)("rows %i.. : tokens and compile outcomes equal Python", (start) => {
    const m = new Mismatches();
    for (const [i, row] of sliced.slice(start, start + SLICE).entries()) {
      const source = row[1] as string;
      const actual = row[0] === "tokens" ? tokensOut(source) : compileAllScopes(source);
      m.check(`#${start + i} ${row[0]} ${label(source)}`, actual, row[2]);
    }
    expectAll(m);
  });

  it("unknown scopes raise Python's ValueError, checked before the source", () => {
    const m = new Mismatches();
    for (const row of rows) {
      if (row[0] !== "scope") continue;
      m.check(
        `${label(row[1])} in ${label(row[2])}`,
        compileOut(String(row[1]), String(row[2])),
        row[3],
      );
    }
    expectAll(m);
  });
});
