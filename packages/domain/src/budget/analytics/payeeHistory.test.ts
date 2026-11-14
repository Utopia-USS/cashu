// One payee's yearly charges for the companion's payee sheet. Synthetic data only.

import { describe, expect, it } from "vitest";
import { D } from "../../decimal.js";
import { type PayeeHit, payeeSummary } from "./payeeHistory.js";

const hit = (date: string, amount: string, over: Partial<PayeeHit> = {}): PayeeHit => ({
  key: `t-${date}`,
  merchantKey: "warta",
  payee: "Warta",
  date,
  amount: D(amount),
  currency: "PLN",
  ...over,
});

describe("payeeSummary", () => {
  it("Warta year by year: count 3 since 2024, +7.9 % and +8.0 %", () => {
    const s = payeeSummary([
      hit("2025-03-14", "-1190"),
      hit("2024-03-14", "-1102"),
      hit("2026-03-14", "-1284", { payee: "WARTA S.A." }),
    ]);
    expect(s?.count).toBe(3);
    expect(s?.since).toBe(2024);
    expect(s?.payee).toBe("WARTA S.A.");
    expect(s?.merchantKey).toBe("warta");
    expect(s?.currency).toBe("PLN");
    expect(s?.rows.map((r) => r.year)).toEqual([2026, 2025, 2024]);
    expect(s?.rows.map((r) => r.amount.toString())).toEqual(["-1284", "-1190", "-1102"]);
    expect(s?.rows[0]?.vsPreviousPct?.toFixed(1)).toBe("7.9");
    expect(s?.rows[1]?.vsPreviousPct?.toFixed(1)).toBe("8.0");
    expect(s?.rows[0]?.vsPreviousPct).toBeCloseTo((94 / 1190) * 100, 10);
    expect(s?.rows[2]?.vsPreviousPct).toBeNull();
  });

  it("a cheaper year is negative; positive amounts work the same", () => {
    const s = payeeSummary([hit("2025-03-14", "1000"), hit("2026-03-14", "900")]);
    expect(s?.rows[0]?.vsPreviousPct).toBeCloseTo(-10, 10);
  });

  it("a zero older amount has no percentage", () => {
    const s = payeeSummary([hit("2025-03-14", "0"), hit("2026-03-14", "-10")]);
    expect(s?.rows[0]?.vsPreviousPct).toBeNull();
  });

  it("null below 2 hits", () => {
    expect(payeeSummary([])).toBeNull();
    expect(payeeSummary([hit("2026-03-14", "-1284")])).toBeNull();
  });

  it("mixed currencies or merchants are refused", () => {
    expect(
      payeeSummary([hit("2025-03-14", "-1190"), hit("2026-03-14", "-280", { currency: "EUR" })]),
    ).toBeNull();
    expect(
      payeeSummary([
        hit("2025-03-14", "-1190"),
        hit("2026-03-14", "-1284", { merchantKey: "pzu" }),
      ]),
    ).toBeNull();
  });
});
