// Additional evaluator boundaries from rules/expr/evaluator.py, beyond the translated grammar suite.
import { expect, it } from "vitest";
import type { UiLang } from "../../../core/i18n.js";
import {
  D,
  Decimal,
  DecimalError,
  getContext,
  localContext,
  makeContext,
} from "../../../decimal.js";
import { expectAll, loadVectors, Mismatches } from "../../../testing/vectors.js";
import { Scope } from "./catalogTypes.js";
import { compileExpression } from "./checker.js";
import { metricLabel } from "./compiled.js";
import { evaluateExpression, type MetricResolver, Unknown, type Value } from "./evaluator.js";

function run(source: string, values: Readonly<Record<string, Value>>, lang: UiLang = "en") {
  return evaluateExpression(
    compileExpression(source, Scope.INSTRUMENT),
    (ref) => {
      const value = values[metricLabel(ref)];
      if (value === undefined) throw new Error("missing synthetic metric");
      return value;
    },
    lang,
  );
}

it.each([
  ["<", [true, false, false, false, false]],
  ["<=", [true, true, true, true, false]],
  [">", [false, false, false, false, true]],
  [">=", [false, true, true, true, true]],
  ["==", [false, true, true, true, false]],
  ["!=", [true, false, false, false, true]],
] as const)("uses the inclusive Decimal tolerance boundary for %s", (op, expected) => {
  const actual = ["-1.1e-9", "-1e-9", "0", "1e-9", "1.1e-9"].map(
    (value) => run(`weight ${op} 0`, { weight: D(value) }).result,
  );
  expect(actual).toEqual(expected);
});

it("keeps signed zero and integers beyond Number precision exact", () => {
  expect(run("weight == 0", { weight: D("-0") }).result).toBe(true);
  expect(run("weight > 9007199254740992", { weight: D("9007199254740993") }).result).toBe(true);
  expect(
    run("+weight == cost_basis", {
      weight: D("123456789012345678901234567890123"),
      cost_basis: D("123456789012345678901234567900000"),
    }).result,
  ).toBe(true);
  expect(
    run("-weight == cost_basis", {
      weight: D("123456789012345678901234567890123"),
      cost_basis: D("-123456789012345678901234567900000"),
    }).result,
  ).toBe(true);
});

it("resolves once per normalized label, in first-use order, even with a decisive operand", () => {
  const expression = compileExpression(
    'true or (holding_has_tag(" x ") and holding_has_tag("x") and drawdown_from_high(002) > weight and drawdown_from_high(2) > weight)',
    Scope.INSTRUMENT,
  );
  const seen: string[] = [];
  const result = evaluateExpression(expression, (ref) => {
    seen.push(metricLabel(ref));
    return new Unknown([metricLabel(ref)]);
  });
  expect(seen).toEqual(['holding_has_tag("x")', "drawdown_from_high(2)", "weight"]);
  expect([...result.values.keys()]).toEqual(seen);
  expect(result.result).toBe(true);
  expect(result.reasons).toEqual([]);
});

it("deduplicates reasons only at the final unknown result, retaining encounter order", () => {
  const first = new Unknown(["shared", "first", "shared"]);
  const result = run("weight + unrealized_pct > 0 and market_value > 0 and weight > 0", {
    weight: first,
    unrealized_pct: new Unknown(["second", "shared"]),
    market_value: new Unknown(["third"]),
  });
  expect(result.result).toBeNull();
  expect(result.reasons).toEqual(["shared", "first", "second", "third"]);
  expect(result.values.get("weight")).toBe(first);
  expect(first.reasons).toEqual(["shared", "first", "shared"]);
});

it.each(["en", "pl"] as const)(
  "preserves division/overflow distinctions and columns in %s",
  (lang) => {
    const division =
      lang === "en" ? "Division by zero (column 14)" : "Dzielenie przez zero (kolumna 14)";
    for (const numerator of ["0", "1"])
      expect(
        run(
          "market_value / cost_basis > 0",
          { market_value: D(numerator), cost_basis: D("-0") },
          lang,
        ).reasons,
      ).toEqual([division]);
    const overflow =
      lang === "en" ? "Arithmetic overflow (column 8)" : "Przepełnienie arytmetyczne (kolumna 8)";
    expect(run("weight * 2 > 0", { weight: D("9e999999") }, lang).reasons).toEqual([overflow]);
    // The column is a code-point index even when an earlier text argument contains an astral character.
    const source = 'holding_has_tag("🙂") and weight / 0 > 1';
    const column = Array.from(source.slice(0, source.indexOf("/"))).length + 1;
    expect(run(source, { 'holding_has_tag("🙂")': true, weight: D("1") }, lang).reasons).toEqual([
      lang === "en"
        ? `Division by zero (column ${column})`
        : `Dzielenie przez zero (kolumna ${column})`,
    ]);
  },
);

it("resolves in the caller context, evaluates in precision 28 and restores the caller context", () => {
  const ambient = makeContext({ prec: 3, Emax: 20, Emin: -20 });
  const expression = compileExpression("weight / 3 == cost_basis", Scope.INSTRUMENT);
  localContext(ambient, () => {
    const seen: number[] = [];
    const result = evaluateExpression(expression, (ref) => {
      seen.push(getContext().prec);
      return ref.name === "weight" ? D("1") : D("0.3333333333333333333333333333");
    });
    expect(result.result).toBe(true);
    expect(seen).toEqual([3, 3]);
    expect(getContext()).toBe(ambient);
    expect(run("weight == 0.333", { weight: D("1").div(D("3")) }).result).toBe(true);
  });
});

it("does not short-circuit AST evaluation or swallow unary/comparison overflow", () => {
  const ambient = getContext();
  for (const source of ["false and +weight > 0", "true or weight > 0"])
    expect(() => run(source, { weight: D("1e1000000") })).toThrow(DecimalError);
  expect(getContext()).toBe(ambient);
});

it("rejects resolver numbers before arithmetic and propagates resolver errors unchanged", () => {
  const expression = compileExpression("weight > 0", Scope.INSTRUMENT);
  expect(() => evaluateExpression(expression, (() => 0.1) as unknown as MetricResolver)).toThrow(
    new TypeError("resolver returned a float for weight"),
  );
  const failure = new Error("synthetic resolver failed");
  expect(() =>
    evaluateExpression(expression, () => {
      throw failure;
    }),
  ).toThrow(failure);
});

type Encoded =
  | ["decimal", string]
  | ["unknown", string[]]
  | ["boolean", boolean]
  | ["string", string];
function decode([kind, value]: Encoded): Value {
  if (kind === "decimal") return D(value);
  if (kind === "unknown") return new Unknown(value);
  return value;
}
function encode(value: Value): Encoded {
  if (value instanceof Decimal) return ["decimal", value.toString()];
  if (value instanceof Unknown) return ["unknown", [...value.reasons]];
  return typeof value === "boolean" ? ["boolean", value] : ["string", value];
}

it("matches the bounded synthetic Python evaluator corpus, including values and errors", () => {
  const mismatches = new Mismatches();
  for (const [index, row] of loadVectors("inv-rules-evaluator").rows.entries()) {
    const [source, lang, input, expected] = row as [
      string,
      UiLang,
      Record<string, Encoded>,
      unknown,
    ];
    const expression = compileExpression(source, Scope.INSTRUMENT);
    const values = new Map(Object.entries(input).map(([label, value]) => [label, decode(value)]));
    let actual: unknown;
    try {
      const result = localContext(makeContext({ prec: 3 }), () =>
        evaluateExpression(
          expression,
          (ref) => {
            const value = values.get(metricLabel(ref));
            if (value === undefined) throw new Error("missing vector metric");
            return value;
          },
          lang,
        ),
      );
      actual = {
        result: result.result,
        reasons: result.reasons,
        values: [...result.values].map(([label, value]) => [label, encode(value)]),
      };
    } catch (error) {
      if (!(error instanceof DecimalError || error instanceof TypeError)) throw error;
      actual = { error: error instanceof DecimalError ? error.signal : error.name };
    }
    mismatches.check(`case ${index}`, actual, expected);
  }
  expectAll(mismatches);
});
