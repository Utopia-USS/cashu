// Port of tests/investments/strategy/test_strategy_loader.py, classes TestBenchmarkAndNotifications
// and TestOtherSections.

import { describe, expect, it } from "vitest";
import { Decimal } from "../../decimal.js";
import { SignalSeverity } from "../domain/enums.js";
import { IssueSeverity, isError, isValid, warningsOf } from "./index.js";
import { configOf, issueAt, load, MINIMAL } from "./testing/load.js";

describe("TestBenchmarkAndNotifications", () => {
  it("test_benchmark_requires_id_and_proxy_currency_defaults_to_base", () => {
    expect(configOf(load(`${MINIMAL}benchmark: { id: acwi, proxy: SPYI.DE }\n`)).benchmark).toEqual(
      {
        id: "acwi",
        proxy: "SPYI.DE",
        currency: "PLN",
      },
    );
    const result = load(`${MINIMAL}benchmark: { currency: euro }\n`);
    expect(issueAt(result, "benchmark.id").message).toBe(
      "benchmark.id is required (e.g. msci_acwi)",
    );
    expect(
      issueAt(result, "benchmark.proxy").message.startsWith("benchmark.proxy is required"),
    ).toBe(true);
    expect(issueAt(result, "benchmark.currency").message).toContain('"euro" is not a three-letter');
    expect(
      issueAt(load(`${MINIMAL}benchmark: { id: a b, proxy: X }\n`), "benchmark.id").message,
    ).toContain("may only contain");
    expect(issueAt(load(`${MINIMAL}benchmark: acwi\n`), "benchmark").message).toBe(
      "benchmark must be a mapping",
    );
  });

  it("test_notifications_are_validated_with_hints", () => {
    const result = load(`${MINIMAL}notifications: { immediate: [acton], digest_weekday: sundy }\n`);
    expect(
      issueAt(result, "notifications.immediate").message.startsWith(
        'Unknown severity "acton" (did you mean "action"?)',
      ),
    ).toBe(true);
    expect(
      issueAt(result, "notifications.digest_weekday").message.startsWith(
        'Unknown weekday "sundy" (did you mean "sunday"?)',
      ),
    ).toBe(true);
    const scalar = load(`${MINIMAL}notifications: { immediate: action }\n`);
    expect(configOf(scalar).notifications.immediate).toEqual(new Set([SignalSeverity.ACTION]));
    expect(
      issueAt(load(`${MINIMAL}notifications: { immediate: { a: 1 } }\n`), "notifications.immediate")
        .message,
    ).toContain("text or a list");
  });
});

describe("TestOtherSections", () => {
  it("test_contributions_and_data_are_validated", () => {
    const result = load(
      `${MINIMAL}contributions: { monthly_amount: 0, day_of_month: 32 }\ndata: { max_stale_weight: 5 }\n`,
    );
    expect(issueAt(result, "contributions.monthly_amount").message).toContain("greater than 0");
    expect(issueAt(result, "contributions.day_of_month").message).toContain("at most 31");
    expect(issueAt(result, "data.max_stale_weight").message).toContain("(fractions: 0.15 = 15%)");
    expect(
      issueAt(
        load(`${MINIMAL}contributions: { day_of_month: 5 }\n`),
        "contributions.monthly_amount",
      ).message,
    ).toBe("monthly_amount is required");
    expect(issueAt(load(`${MINIMAL}data: 5\n`), "data").message).toBe("data must be a mapping");
    const exact = load(`${MINIMAL}contributions: { monthly_amount: "1234.56" }\n`);
    const contributions = configOf(exact).contributions;
    expect(contributions).not.toBeNull();
    expect(contributions?.monthlyAmount.eq(Decimal.parse("1234.56"))).toBe(true);
  });

  it("test_watchlist_criteria", () => {
    const result = load(`${MINIMAL}watchlist:\n  criteria: { max_pee: 20, min_roe: 0.1 }\n`);
    expect(isValid(result)).toBe(true);
    expect(issueAt(result, "watchlist.criteria.max_pee").message).toContain(
      'did you mean "max_pe"',
    );
    expect(Object.fromEntries(configOf(result).watchlist.values)).toEqual({
      max_pee: 20.0,
      min_roe: 0.1,
    });
    expect(
      isError(
        issueAt(
          load(`${MINIMAL}watchlist:\n  criteria: { max_pe: low }\n`),
          "watchlist.criteria.max_pe",
        ),
      ),
    ).toBe(true);
    expect(
      isError(
        issueAt(
          load(`${MINIMAL}watchlist:\n  criteria: { max_pe: .inf }\n`),
          "watchlist.criteria.max_pe",
        ),
      ),
    ).toBe(true);
    expect(isError(issueAt(load(`${MINIMAL}watchlist: [1]\n`), "watchlist"))).toBe(true);
    expect(
      isError(issueAt(load(`${MINIMAL}watchlist: { criteria: [1] }\n`), "watchlist.criteria")),
    ).toBe(true);
  });

  it("test_an_empty_strategy_md_is_a_warning_without_location", () => {
    const result = load(MINIMAL, "  \n");
    expect(isValid(result)).toBe(true);
    const issue = warningsOf(result)[0];
    expect([issue?.path, issue?.line, issue?.severity]).toEqual([
      "strategy.md",
      null,
      IssueSeverity.WARNING,
    ]);
  });
});
