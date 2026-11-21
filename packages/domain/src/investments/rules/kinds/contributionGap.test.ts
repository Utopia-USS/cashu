// Python test_rules_contribution_gap.py, including no-value portfolios and the exact day boundary.
import { expect, it } from "vitest";
import { describe, fired, runKind, skipped } from "../testing/evaluate.js";
import { context, d, day, portfolio } from "../testing/fixtures.js";
import { ContributionGapParams, contributionGapRule } from "./contributionGap.js";

const plan = { monthlyAmount: d("1000"), dayOfMonth: 10 };
it.each([
  ["2026-08-20", "fired"],
  ["2026-08-22", "not_fired"],
  ["2026-10-03", "not_fired"],
] as const)(
  "latest deposit %s produces %s at the exact period plus grace boundary",
  (last, type) => {
    const ctx = context({
      portfolioValue: portfolio([], { deposits: [day("2026-07-01"), day(last)] }),
      contributions: plan,
    });
    const result = runKind(contributionGapRule, ctx, new ContributionGapParams());
    expect(describe(result)).toEqual([`${type} r`]);
    if (type === "fired") {
      expect(fired(result[0]).message).toBe(
        "Brak wpłaty od 43 dni (ostatnia 2026-08-20); plan dopuszcza 41 dni.",
      );
      expect(fired(result[0]).payload.days_since_last_deposit).toBe(43);
    }
  },
);
it("no deposits fires with the plan amount, while no plan skips", () => {
  expect(
    fired(
      runKind(
        contributionGapRule,
        context({ contributions: plan }),
        new ContributionGapParams(),
      )[0],
    ).message,
  ).toBe("Brak wpłat, choć plan zakłada 1\u00a0000 PLN miesięcznie.");
  expect(
    fired(
      runKind(
        contributionGapRule,
        context({ contributions: plan, lang: "en" }),
        new ContributionGapParams(),
      )[0],
    ).message,
  ).toBe("No contributions, though the plan expects 1,000 PLN a month.");
  expect(skipped(runKind(contributionGapRule, context(), new ContributionGapParams())[0])).toBe(
    "Strategia nie ma planu wpłat",
  );
});
