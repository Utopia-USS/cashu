// The closed month's rules the screen and the notification planner share: complete only for the asked
// month with base-currency figures; the plan amount is the suggestion capped at the monthly plan; a plan
// is settled when none is needed, when it is too late to date one, or when it is saved. Synthetic data.
import { D } from "@cashu/domain";
import { type MonthCloseFacts, monthClosedState } from "./monthClosedRules";

function facts(over: Partial<MonthCloseFacts> = {}): MonthCloseFacts {
  return {
    month: "2026-10",
    complete: true,
    baseCurrency: "PLN",
    plannedDeposit: null,
    currencies: [{ currency: "PLN", suggestedTransfer: D("1200") }],
    investing: null,
    ...over,
  };
}

const NOV_3 = "2026-11-03";

describe("monthClosedState", () => {
  it("is complete only for the asked month with base-currency figures", () => {
    expect(monthClosedState(facts(), "2026-10", NOV_3).complete).toBe(true);
    expect(monthClosedState(facts({ complete: false }), "2026-10", NOV_3).complete).toBe(false);
    expect(monthClosedState(facts({ month: "2026-09" }), "2026-10", NOV_3).complete).toBe(false);
    expect(
      monthClosedState(
        facts({ currencies: [{ currency: "EUR", suggestedTransfer: D("10") }] }),
        "2026-10",
        NOV_3,
      ).complete,
    ).toBe(false);
  });

  it("needs no plan without investing", () => {
    const state = monthClosedState(facts(), "2026-10", NOV_3);
    expect(state.planSaved).toBe(true);
    expect(state.planAmount?.format("f")).toBe("1200");
  });

  it("caps the suggestion at the monthly plan and waits for the plan to be saved", () => {
    const investing = {
      planned: { amount: D("1000") },
      comparison: { suggestedTransfer: D("1500") },
    };
    const open = monthClosedState(facts({ investing }), "2026-10", NOV_3);
    expect(open.planAmount?.format("f")).toBe("1000");
    expect(open.canPlan).toBe(true);
    expect(open.planSaved).toBe(false);
    const saved = monthClosedState(
      facts({
        investing,
        plannedDeposit: { gid: "synthetic-plan", amount: D("1000"), currency: "PLN" },
      }),
      "2026-10",
      NOV_3,
    );
    expect(saved.planSaved).toBe(true);
  });

  it("does not wait for a plan that can no longer be dated or has nothing to put away", () => {
    const investing = { planned: null, comparison: { suggestedTransfer: D("800") } };
    const late = monthClosedState(facts({ investing }), "2026-09", NOV_3);
    expect(late.canPlan).toBe(false);
    expect(late.planSaved).toBe(true);
    const nothing = monthClosedState(
      facts({ investing: { planned: null, comparison: { suggestedTransfer: D("0") } } }),
      "2026-10",
      NOV_3,
    );
    expect(nothing.planSaved).toBe(true);
  });
});
