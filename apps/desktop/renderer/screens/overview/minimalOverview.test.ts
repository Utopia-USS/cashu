import { D } from "@cashu/domain";
import { setLanguageForTests } from "@cashu/i18n";
import type { PortfolioSnapshot } from "@cashu/store/investments/screen";
import type { InvestmentWidgets } from "@cashu/store/overview";
import { beforeEach, describe, expect, it } from "vitest";
import { depositFacts, investmentsOnlyOverview, minimalOverviewModel } from "./minimalOverview.js";

beforeEach(() => setLanguageForTests("en"));

describe("investmentsOnlyOverview (Python Overview `minimal`)", () => {
  it.each([
    ["ready", true],
    ["partial", true],
    ["empty", false],
  ])("investments alone in state %s -> %s", (setupState, expected) => {
    expect(investmentsOnlyOverview([{ id: "investments", setupState }])).toBe(expected);
  });

  it("keeps the full overview for any other module set", () => {
    expect(investmentsOnlyOverview([])).toBe(false);
    expect(investmentsOnlyOverview([{ id: "budget", setupState: "ready" }])).toBe(false);
    expect(
      investmentsOnlyOverview([
        { id: "budget", setupState: "ready" },
        { id: "investments", setupState: "ready" },
      ]),
    ).toBe(false);
  });
});

describe("depositFacts", () => {
  it("counts the current month only once its deposit is in", () => {
    const points = [
      { date: "2026-08-10", flow: 2000 },
      { date: "2026-08-20", flow: null },
      { date: "2026-09-10", flow: 2000 },
      { date: "2026-09-15", flow: -50 },
    ];
    const before = depositFacts(points, "2026-10-04");
    expect(before.monthsSince).toBe(2);
    expect(before.withDeposit).toBe(2);
    expect(before.same?.toString()).toBe("2000");
    expect(before.last?.date).toBe("2026-09-10");
    const after = depositFacts([...points, { date: "2026-10-03", flow: 500 }], "2026-10-04");
    expect(after.monthsSince).toBe(3);
    expect(after.same).toBeNull();
  });
});

const portfolio = (overrides: Record<string, unknown> = {}) =>
  ({
    status: "ready",
    overview: {
      base_currency: "PLN",
      kpis: {
        value: { total: D("8400") },
        polarity: { positive: 1, negative: 1, neutral: 0 },
        alerts: { active: 0, triggered: 0, snoozed: 0 },
      },
      accounts: [{ id: "a".repeat(32), name: "Synthetic", broker: "manual", wrapper: "regular" }],
    },
    positions: {
      positions: [{ instrument: { symbol: "SYN", label: "Synthetic fund" } }],
    },
    performance: {
      points: [
        { date: "2026-07-10", flow: 2000 },
        { date: "2026-08-10", flow: 2000 },
        { date: "2026-09-10", flow: 2000 },
      ],
      summary: { pnl: 400, net_contributions: 8000 },
      benchmark: { status: "no_benchmark", id: null, twr: null, simulation: null },
      data_quality: null,
    },
    contributionPlan: null,
    ...overrides,
  }) as unknown as Extract<PortfolioSnapshot, { status: "ready" }>;

const investment = (openPlans: { plannedDate: string; amount: string }[]): InvestmentWidgets =>
  ({
    status: "available",
    openPlans: openPlans.map((plan, index) => ({
      gid: String(index),
      amount: D(plan.amount),
      currency: "PLN",
      plannedDate: plan.plannedDate,
    })),
  }) as unknown as InvestmentWidgets;

describe("minimalOverviewModel", () => {
  it("derives the plan from the repeated deposit and offers the month's step", () => {
    const model = minimalOverviewModel({
      portfolio: portfolio(),
      investment: investment([]),
      today: "2026-10-04",
      privacy: false,
    });
    expect(model.due).toBe("2026-10-10");
    expect(model.plan?.amount.toString()).toBe("2000");
    expect(model.plan?.account).toBe("a".repeat(32));
    expect(model.pnl?.ratio.toString()).toBe("0.05");
    expect(model.holdings).toContain("SYN");
    expect(model.quiet).toBe("no alerts · 2 signals");
    expect(model.regularity).toBe("3 of 3");
    expect(model.chart.labels).toHaveLength(6);
    expect(model.chart.kinds.at(-1)).toBe("plan");
    expect(model.chart.plan).toBe(2000);
    expect(model.previous?.label).toBe("September contribution");
    expect(model.current).toMatchObject({ done: false, canPlan: true });
    expect(model.benchmarkDetail).toBe("set it in the strategy");
  });

  it("marks the step done for this month's open plan and prefers the strategy plan", () => {
    const model = minimalOverviewModel({
      portfolio: portfolio({ contributionPlan: { monthlyAmount: D("2500"), dayOfMonth: 15 } }),
      investment: investment([{ plannedDate: "2026-10-15", amount: "2500" }]),
      today: "2026-10-04",
      privacy: false,
    });
    expect(model.due).toBe("2026-10-15");
    expect(model.plan?.amount.toString()).toBe("2500");
    expect(model.current).toMatchObject({ done: true, canPlan: false });
    expect(model.current.detail).toMatch(/^planned /u);
  });

  it("is done once this month's deposit is in and masks amounts in privacy mode", () => {
    const base = portfolio();
    const model = minimalOverviewModel({
      portfolio: portfolio({
        performance: {
          ...base.performance,
          points: [...base.performance.points, { date: "2026-10-02", flow: 2000 }],
        },
      }),
      investment: investment([]),
      today: "2026-10-04",
      privacy: true,
    });
    expect(model.current).toMatchObject({ done: true, canPlan: false, detail: "done this month" });
    expect(model.chart.kinds.at(-1)).toBe("main");
    expect(model.depositedDetail).not.toMatch(/\d{3}/u);
    expect(model.chart.planLabel).toBe("plan •••");
    expect(model.previous?.detail).toMatch(/^•••/u);
  });
});
