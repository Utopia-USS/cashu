// Port of tests/investments/strategy/test_strategy_loader.py, class TestBucketsAndAllocation.

import { describe, expect, it } from "vitest";
import { AssetClass } from "../domain/enums.js";
import { errorsOf, isError, isValid, warningsOf } from "./index.js";
import { configOf, issueAt, load, MINIMAL } from "./testing/load.js";

const TWO_BUCKETS = `buckets:
  - id: stocks
    match: { asset_class: [equity, etf] }
  - id: cash
    match: { asset_class: cash }
`;

function strategy(buckets = "", allocation = ""): string {
  return MINIMAL + buckets + allocation;
}

describe("TestBucketsAndAllocation", () => {
  it("test_targets_must_sum_to_1", () => {
    const result = load(
      strategy(TWO_BUCKETS, "allocation:\n  targets: { stocks: 0.9, cash: 0.05 }\n"),
    );
    const issue = issueAt(result, "allocation.targets");
    expect(issue.message).toBe("Targets sum to 0.950, expected 1 (+-0.001)");
    expect([issue.line, issue.column]).toEqual([9, 12]);
    expect(
      isValid(load(strategy(TWO_BUCKETS, "allocation:\n  targets: { stocks: 0.9995, cash: 0 }\n"))),
    ).toBe(true);
  });

  it("test_targets_reference_defined_buckets_and_stay_within_0_1", () => {
    const result = load(
      strategy(TWO_BUCKETS, "allocation:\n  targets: { stoks: 0.95, cash: 1.05 }\n"),
    );
    const unknown = issueAt(result, "allocation.targets.stoks");
    expect(unknown.message).toBe(
      'Target references undefined bucket "stoks" (did you mean "stocks"?)',
    );
    expect([unknown.line, unknown.column]).toEqual([9, 14]);
    expect(issueAt(result, "allocation.targets.cash").message).toContain("between 0 and 1");
    expect(
      errorsOf(result).filter((i) => i.path === "allocation.targets"),
      "no sum check on bad values",
    ).toEqual([]);
  });

  it("test_targets_without_any_bucket", () => {
    const issue = issueAt(
      load(strategy("", "allocation:\n  targets: { stocks: 1 }\n")),
      "allocation.targets.stocks",
    );
    expect(issue.message).toContain("no buckets are defined");
  });

  it("test_allocation_needs_targets_and_a_bucket_without_target_gets_0", () => {
    expect(
      isError(issueAt(load(strategy(TWO_BUCKETS, "allocation: {}\n")), "allocation.targets")),
    ).toBe(true);
    const result = load(strategy(TWO_BUCKETS, "allocation:\n  targets: { stocks: 1 }\n"));
    expect(isValid(result)).toBe(true);
    expect(warningsOf(result)[0]?.message).toContain('Bucket "cash" has no target');
    expect(Object.fromEntries(configOf(result).allocation.targets)).toEqual({
      stocks: 1.0,
      cash: 0.0,
    });
    expect(isError(issueAt(load(strategy(TWO_BUCKETS, "allocation: [1]\n")), "allocation"))).toBe(
      true,
    );
    expect(
      isError(
        issueAt(
          load(strategy(TWO_BUCKETS, "allocation: { targets: [1] }\n")),
          "allocation.targets",
        ),
      ),
    ).toBe(true);
  });

  it("test_buckets_without_allocation_are_a_warning", () => {
    const result = load(strategy(TWO_BUCKETS));
    expect(isValid(result)).toBe(true);
    expect(issueAt(result, "buckets").message).toContain("allocation.targets is missing");
  });

  it("test_bucket_ids_required_well_formed_unique_and_match_required", () => {
    const result = load(
      strategy(`buckets:
  - id: stocks
    match: { asset_class: equity }
  - id: stocks
    match: { asset_class: etf }
  - id: "bad id"
    match: {}
  - match: {}
  - id: nomatch
  - just a string
`),
    );
    expect(issueAt(result, "buckets[1].id").message).toBe(
      'Duplicate bucket id "stocks" (first defined on line 4)',
    );
    expect(issueAt(result, "buckets[2].id").message).toContain("may only contain letters");
    expect(issueAt(result, "buckets[3].id").message).toBe("Bucket id is required");
    expect(issueAt(result, "buckets[4].match").message).toContain("match is required");
    expect(issueAt(result, "buckets[5]").message).toContain("must be a mapping");
    expect(isError(issueAt(load(strategy("buckets: { a: 1 }\n")), "buckets"))).toBe(true);
  });

  it("test_match_values_are_validated_with_hints", () => {
    const result = load(
      strategy(
        "buckets:\n  - id: a\n    match: { asset_class: [equity, bnd], currency: euro, tags: [{x: 1}] }\n",
      ),
    );
    const assetClass = issueAt(result, "buckets[0].match.asset_class");
    expect(assetClass.message).toContain('Unknown asset class "bnd" (did you mean "bond"?)');
    expect([assetClass.line, assetClass.column]).toEqual([5, 27]);
    expect(issueAt(result, "buckets[0].match.currency").message).toContain(
      '"euro" is not a three-letter',
    );
    expect(issueAt(result, "buckets[0].match.tags[0]").message).toContain("got a mapping");
  });

  it("test_claim_is_a_known_asset_class", () => {
    const result = load(
      strategy("buckets:\n  - id: c\n    match: { asset_class: [claim, cash] }\n"),
    );
    expect(configOf(result).allocation.buckets[0]?.match.assetClasses).toEqual(
      new Set([AssetClass.CLAIM, AssetClass.CASH]),
    );
  });

  it("test_a_catch_all_bucket_not_last_and_a_missing_cash_bucket_are_warnings", () => {
    const result = load(
      strategy(
        "buckets:\n  - id: everything\n    match: {}\n  - id: stocks\n    match: { asset_class: equity }\n",
        "allocation:\n  targets: { everything: 0.5, stocks: 0.5 }\n",
      ),
    );
    expect(isValid(result)).toBe(true);
    expect(issueAt(result, "buckets[0].match").message).toContain("matches every instrument");
    const noCash = load(
      strategy(
        "buckets:\n  - id: stocks\n    match: { asset_class: equity }\n",
        "allocation:\n  targets: { stocks: 1 }\n",
      ),
    );
    expect(issueAt(noCash, "buckets").message).toContain("No bucket matches asset_class: cash");
  });

  it("test_rebalance_values_are_validated", () => {
    const result = load(
      strategy(
        TWO_BUCKETS,
        "allocation:\n  targets: { stocks: 1 }\n  rebalance: { absolute_band_pp: 0, min_trade_value: -5 }\n",
      ),
    );
    expect(issueAt(result, "allocation.rebalance.absolute_band_pp").message).toContain(
      "greater than 0",
    );
    expect(issueAt(result, "allocation.rebalance.min_trade_value").message).toContain("at least 0");
  });
});
