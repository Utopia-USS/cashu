import { describe, expect, it } from "vitest";
import { surplusApplies } from "./investmentsModel.js";
import type { OverviewInvestments, PlanRow } from "./useOverviewInvestments.js";

/** The parts of the investments reads the card's visibility looks at. */
function inv(args: {
  planned?: { amount: number; currency: string; day_of_month: number | null } | null;
  monthly?: number | null;
  plans?: PlanRow[] | null;
}): OverviewInvestments {
  return {
    monthClose: {
      investing:
        args.planned === undefined
          ? null
          : {
              enabled: true,
              strategy_state: "ready",
              planned: args.planned,
              comparison: null,
            },
    },
    plan:
      args.monthly === undefined
        ? null
        : { monthly_amount: args.monthly, covered: false, remaining: null, currency: "PLN" },
    plans: args.plans ?? [],
  } as unknown as OverviewInvestments;
}
const TODAY = "2026-11-09";

describe("surplusApplies (Nadwyżka -> inwestycje)", () => {
  it("no contribution plan anywhere: the card stays away", () => {
    expect(surplusApplies(inv({}), TODAY)).toBe(false);
    expect(surplusApplies(inv({ planned: null, monthly: null }), TODAY)).toBe(false);
  });

  it("a monthly contribution in the strategy shows it", () => {
    const planned = { amount: 2000, currency: "PLN", day_of_month: 12 };
    expect(surplusApplies(inv({ planned }), TODAY)).toBe(true);
    expect(surplusApplies(inv({ monthly: 1500 }), TODAY)).toBe(true);
  });

  it("a deposit planned for this month shows it, one of another month does not", () => {
    const row = (date: string): PlanRow => ({
      id: 1,
      gid: "plan-1",
      amount: 1000,
      currency: "PLN",
      planned_date: date,
      status: "planned",
      booked_at: null,
    });
    expect(surplusApplies(inv({ plans: [row("2026-11-15")] }), TODAY)).toBe(true);
    expect(surplusApplies(inv({ plans: [row("2026-10-15")] }), TODAY)).toBe(false);
  });
});
