import { D } from "@cashu/domain";
import { setLanguageForTests } from "@cashu/i18n";
import { setIncognito } from "@cashu/ui-logic/core/incognito";
import { beforeEach, describe, expect, it } from "vitest";
import { type SubscriptionRow, subscriptionsState } from "./subscriptionsModel.js";

beforeEach(() => setLanguageForTests("en"));

/** A synthetic recurring payment. */
const row = (
  counterparty: string,
  amount: string,
  gap: number,
  last: string,
  active = true,
  currency = "PLN",
): SubscriptionRow =>
  ({
    counterparty,
    typicalAmount: D(amount),
    occurrences: 6,
    monthsCovered: 6,
    medianGapDays: gap,
    lastDate: last,
    currency,
    active,
  }) as SubscriptionRow;

const base = {
  today: "2026-11-09",
  base: "PLN",
  open: false,
  toggle: () => {},
  spendingOf: (c: string) => (c === "PLN" ? D("10000.00") : null),
};

describe("subscriptionsState", () => {
  const rows = [
    row("Synthetic video", "60.00", 31, "2026-11-02"),
    row("Synthetic music", "38.00", 31, "2026-10-14"),
    row("Synthetic gym", "159.00", 30, "2026-10-11"),
    row("Synthetic cloud", "50.00", 31, "2026-10-18"),
    row("Synthetic phone", "45.00", 30, "2026-10-21"),
    row("Synthetic news", "10.00", 14, "2026-11-01", true, "EUR"),
    row("Synthetic old", "27.00", 31, "2026-05-02", false),
  ];

  it("lists the active ones by their next charge and folds the rest", () => {
    const s = subscriptionsState({ ...base, rows });
    expect(s.next.map((r) => r.payee)).toEqual([
      "Synthetic gym",
      "Synthetic music",
      "Synthetic news",
      "Synthetic cloud",
    ]);
    expect(s.next.map((r) => r.when)).toEqual(["tomorrow", "in 5 days", "in 6 days", "in 9 days"]);
    expect(s.next[0]?.soon).toBe(true);
    expect(s.next[3]?.soon).toBe(false);
    expect(s.next[2]?.cadence).toBe("every 14 days");
    expect(s.next[0]?.cadence).toBe("monthly");
    expect(s.rest.map((r) => r.payee)).toEqual(["Synthetic phone", "Synthetic video"]);
    expect(s.ended.map((r) => r.payee)).toEqual(["Synthetic old"]);
    expect(s.ended[0]?.when).toBeNull();
    expect(s.count).toBe("6 active");
    expect(s.toggle?.label).toBe("Show all 6 and 1 ended");
  });

  it("totals the month as the Overview does: the typical amounts, per currency, unscaled", () => {
    const s = subscriptionsState({ ...base, rows });
    expect(s.monthly?.unit).toBe("/ month");
    expect(s.monthly?.value).toContain("352.00");
    expect(s.extra).toHaveLength(1);
    expect(s.extra[0]).toContain("10.00");
    expect(s.sub).toContain("4,224");
    expect(s.sub).toContain("a year");
    expect(s.sub).toContain("4% of spending");
  });

  it("shows payees but masks amounts in incognito", () => {
    setIncognito(true);
    const s = subscriptionsState({ ...base, rows });
    setIncognito(false);
    expect(s.next.map((r) => r.payee)).toContain("Synthetic gym");
    expect(s.next.every((r) => r.initial !== "•" && !/\d/.test(r.amount))).toBe(true);
  });

  it("says so without any", () => {
    const s = subscriptionsState({ ...base, rows: [] });
    expect(s.empty).toBe("No subscriptions.");
    expect(s.monthly).toBeNull();
    expect(s.toggle).toBeNull();
  });
});
