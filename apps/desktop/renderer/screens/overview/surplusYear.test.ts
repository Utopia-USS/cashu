import { setLanguageForTests } from "@cashu/i18n";
import { beforeEach, describe, expect, it } from "vitest";
import { surplusYear } from "./investmentsModel.js";

beforeEach(() => setLanguageForTests("en"));

/** One synthetic deposit on the 5th of each listed month of 2026. */
const deposits = (months: number[]) =>
  months.map((m) => ({ date: `2026-${String(m).padStart(2, "0")}-05`, flow: 1000 }));

describe("surplusYear", () => {
  it("is null without a monthly plan amount", () => {
    expect(
      surplusYear({
        points: deposits([1, 2]),
        today: "2026-11-09",
        amount: null,
        currency: "PLN",
        firstDeposit: "2025-06-05",
        planned: null,
      }),
    ).toBeNull();
  });

  it("counts deposited months against the months so far, this month once deposited", () => {
    const y = surplusYear({
      points: deposits([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      today: "2026-11-09",
      amount: 1000,
      currency: "PLN",
      firstDeposit: "2025-06-05",
      planned: { amount: 1000, currency: "PLN", planned_date: "2026-11-10", status: "planned" },
    });
    expect(y?.months.map((m) => m.state)).toEqual([
      "on",
      "on",
      "on",
      "on",
      "on",
      "on",
      "on",
      "on",
      "on",
      "missed",
      "planned",
      "ahead",
    ]);
    // January .. October count (November has no deposit yet): 9 of 10.
    expect([y?.covered, y?.due, y?.pct]).toEqual([9, 10, 90]);
    expect(y?.months.map((m) => m.initial).join("")).toBe("JFMAMJJASOND");
  });

  it("starts the plan at this year's first deposit and counts a deposited current month", () => {
    const y = surplusYear({
      points: deposits([7, 9, 11]),
      today: "2026-11-09",
      amount: 500,
      currency: "PLN",
      firstDeposit: "2026-07-05",
      planned: null,
    });
    expect(y?.months.slice(5, 12).map((m) => m.state)).toEqual([
      "before",
      "on",
      "missed",
      "on",
      "missed",
      "on",
      "ahead",
    ]);
    expect([y?.covered, y?.due]).toEqual([3, 5]);
  });

  it("marks the current month due when nothing is planned or deposited", () => {
    const y = surplusYear({
      points: [],
      today: "2026-01-20",
      amount: 500,
      currency: "PLN",
      firstDeposit: null,
      planned: null,
    });
    expect(y?.months[0]?.state).toBe("due");
    expect([y?.covered, y?.due, y?.pct]).toEqual([0, 0, null]);
  });
});
