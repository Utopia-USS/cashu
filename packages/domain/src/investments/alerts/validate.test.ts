/** Alert definitions are checked before they are stored: kind, scope, params, title, note and tag. */
import { describe, expect, it } from "vitest";
import type { PyPlain } from "../../pyYaml/plain.js";
import { KINDS } from "./types.js";
import {
  type AlertIssue,
  AlertValidationError,
  validateAlert,
  validateTag,
  validateText,
} from "./validate.js";

function issues(fn: () => unknown): readonly AlertIssue[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof AlertValidationError) return error.issues;
    throw error;
  }
  throw new Error("no AlertValidationError");
}
const onInstrument = { hasInstrument: true };
const params = (kind: string, raw: Record<string, unknown>) =>
  validateAlert(kind, raw, onInstrument).params;

describe("kind and scope", () => {
  it("the kind is required and an unknown one gets a hint", () => {
    expect(issues(() => validateAlert("", {}, onInstrument))).toEqual([
      ["kind", `kind is required; known: ${KINDS.join(", ")}`],
    ]);
    expect(issues(() => validateAlert("price_abve", {}, onInstrument))[0]?.[1]).toContain(
      'Unknown alert kind "price_abve" (did you mean "price_above"?)',
    );
  });

  it("price kinds need an instrument; the scope follows the instrument or the bucket", () => {
    expect(
      issues(() => validateAlert("price_above", { level: 1 }, { hasInstrument: false })),
    ).toEqual([
      [
        "instrument",
        "price_above alerts need an instrument (add it to the watchlist first if it is not held)",
      ],
    ]);
    expect(validateAlert("weight_above", { threshold: 0.1 }, onInstrument).scope).toBe(
      "instrument",
    );
    expect(
      validateAlert(
        "weight_above",
        { threshold: 0.1, bucket: " equity " },
        { hasInstrument: false },
      ),
    ).toEqual({
      kind: "weight_above",
      scope: "bucket",
      params: { threshold: 0.1, bucket: "equity" },
      bucketRefs: ["equity"],
    });
    expect(
      validateAlert("custom", { expression: "cash_weight > 10%" }, { hasInstrument: false }).scope,
    ).toBe("portfolio");
  });

  it("scope and bucket mismatches are refused", () => {
    expect(
      issues(() =>
        validateAlert("price_above", { level: 1 }, { scope: "portfolio", hasInstrument: true }),
      ),
    ).toEqual([["scope", "price_above alerts apply to scope instrument, not portfolio"]]);
    expect(
      issues(() =>
        validateAlert(
          "weight_above",
          { threshold: 0.1 },
          { scope: "bucket", hasInstrument: false },
        ),
      ),
    ).toEqual([["params.bucket", "scope bucket needs params.bucket (a strategy bucket id)"]]);
    expect(
      issues(() =>
        validateAlert("weight_above", { threshold: 0.1, bucket: "equity" }, onInstrument),
      ),
    ).toEqual([["params.bucket", "bucket only applies to scope bucket"]]);
  });
});

describe("params", () => {
  it("levels and thresholds keep their bounds; defaults are filled in", () => {
    expect(issues(() => params("price_above", { level: 0 }))[0]?.[0]).toBe("params.level");
    expect(params("change_pct", { window_days: 5, threshold: 0.1 })).toEqual({
      window_days: 5,
      threshold: 0.1,
      direction: "any",
    });
    expect(
      issues(() => params("change_pct", { window_days: 0, threshold: 11 })).map((i) => i[0]),
    ).toEqual(["params.window_days", "params.threshold"]);
    expect(params("drawdown_from_high", { threshold: 0.2 })).toEqual({
      window_days: 252,
      threshold: 0.2,
    });
    expect(issues(() => params("drawdown_from_high", { threshold: 1 }))[0]?.[0]).toBe(
      "params.threshold",
    );
    expect(params("range_breakout", {})).toEqual({
      window_days: 30,
      max_range_pct: 0.08,
      direction: "any",
    });
    expect(params("volume_spike", {})).toEqual({ window_days: 20, multiple: 2.5 });
  });

  it("choices are normalized, a missing required one and an unknown one are refused", () => {
    expect(params("sma_cross", { direction: " Above " })).toEqual({
      window_days: 200,
      direction: "above",
    });
    expect(issues(() => params("sma_cross", {}))).toEqual([
      ["params.direction", "direction is required: above or below"],
    ]);
    expect(
      issues(() =>
        params("change_pct", { window_days: 5, threshold: 0.1, direction: "upp" }),
      )[0]?.[1],
    ).toContain('Unknown direction "upp"');
  });

  it("an unknown parameter is an error, not silently ignored", () => {
    const found = issues(() => params("price_above", { level: 1, levle: 2 }));
    expect(found).toHaveLength(1);
    expect(found[0]?.[0]).toBe("params.levle");
    expect(found[0]?.[1]).not.toContain("it is ignored");
  });

  it("a custom expression is compiled in the alert's scope, normalized, with bucket references", () => {
    const ok = validateAlert(
      "custom",
      { expression: "bucket_weight('equity')  >  50%" },
      { scope: "portfolio", hasInstrument: false },
    );
    expect(ok.params.expression).toBe("bucket_weight('equity') > 50%");
    expect(ok.bucketRefs).toEqual(["equity"]);
    expect(issues(() => validateAlert("custom", {}, { hasInstrument: false }))).toEqual([
      ["params.expression", 'expression is required: e.g. "weight > 10%"'],
    ]);
    expect(
      issues(() =>
        validateAlert("custom", { expression: "cash_weight >" }, { hasInstrument: false }),
      )[0]?.[1],
    ).toMatch(/\(column \d+ of the expression\)$/);
    expect(
      issues(() =>
        validateAlert("custom", { expression: "last_close > 1" }, { hasInstrument: false }),
      )[0]?.[1],
    ).toContain("not available in scope portfolio");
  });

  it("JSON integers count as whole numbers; a float in a YAML map does not", () => {
    expect(params("change_pct", { window_days: 2, threshold: 0.1 }).window_days).toBe(2);
    expect(() =>
      validateAlert(
        "change_pct",
        new Map<string, PyPlain>([
          ["window_days", 2],
          ["threshold", 0.1],
        ]),
        onInstrument,
      ),
    ).toThrow("must be a whole number");
    expect(
      validateAlert(
        "change_pct",
        new Map<string, PyPlain>([
          ["window_days", 2n],
          ["threshold", 0.1],
        ]),
        onInstrument,
      ).params.window_days,
    ).toBe(2);
  });
});

describe("title, note and tag", () => {
  it("the title is one short line, an empty note is no note", () => {
    expect(validateText("  VWCE below 100 ", "  ")).toEqual(["VWCE below 100", null]);
    expect(issues(() => validateText(" ", null))[0]?.[0]).toBe("title");
    expect(issues(() => validateText("a\nb", null))[0]?.[1]).toBe(
      "title must be one line of at most 120 characters",
    );
    expect(issues(() => validateText("ok", "x".repeat(2001)))).toEqual([
      ["note", "note is too long (max 2000 characters)"],
    ]);
  });

  it("a tag is lower case with collapsed spaces, letters (Polish too), digits and hyphens only", () => {
    expect(validateTag("  Cena   Złota ")).toBe("cena złota");
    expect(validateTag(null)).toBeNull();
    expect(validateTag("   ")).toBeNull();
    expect(issues(() => validateTag("cena!"))[0]?.[0]).toBe("tag");
    expect(issues(() => validateTag("x".repeat(25)))).toEqual([
      ["tag", "tag must be at most 24 characters"],
    ]);
  });
});
