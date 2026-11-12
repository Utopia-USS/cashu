// Upcoming charges of the companion: next dates, the [today - 1, today + 7] window, coverage per account
// and totals per currency. Synthetic data only.

import { describe, expect, it } from "vitest";
import { D, type Decimal } from "../../decimal.js";
import {
  type AccountBalance,
  type InstallmentDue,
  nextChargeDate,
  type PlannedOutflow,
  type RecurringCharge,
  UPCOMING_GRACE_DAYS,
  UPCOMING_HORIZON_DAYS,
  type UpcomingInput,
  upcomingCharges,
} from "./upcoming.js";

const eq = (a: Decimal | null | undefined, b: string) => expect(a?.eq(D(b))).toBe(true);
const main = { id: "a1", name: "Main" };
const second = { id: "a2", name: "Second" };

const sub = (key: string, lastDate: string, amount: string, over: Partial<RecurringCharge> = {}) =>
  ({
    key,
    payee: key,
    typicalAmount: D(amount),
    currency: "PLN",
    lastDate,
    medianGapDays: 30,
    account: main,
    ...over,
  }) satisfies RecurringCharge;
const inst = (key: string, date: string, amount: string, over: Partial<InstallmentDue> = {}) =>
  ({
    key,
    loan: "l1",
    name: key,
    date,
    amount: D(amount),
    currency: "PLN",
    account: main,
    ...over,
  }) satisfies InstallmentDue;
const plan = (key: string, date: string, amount: string, over: Partial<PlannedOutflow> = {}) =>
  ({
    key,
    name: key,
    date,
    amount: D(amount),
    currency: "PLN",
    account: main,
    ...over,
  }) satisfies PlannedOutflow;
const bal = (id: string, balance: string, currency = "PLN"): AccountBalance => ({
  id,
  name: id,
  currency,
  balance: D(balance),
});
const input = (over: Partial<UpcomingInput>): UpcomingInput => ({
  today: "2026-11-12",
  recurring: [],
  installments: [],
  planned: [],
  balances: [],
  ...over,
});

describe("nextChargeDate", () => {
  it("monthly: the same day next month, clamped", () => {
    expect(nextChargeDate("2026-10-14", 30)).toBe("2026-11-14");
    expect(nextChargeDate("2026-10-14", 28)).toBe("2026-11-14");
    expect(nextChargeDate("2026-10-14", 32)).toBe("2026-11-14");
    expect(nextChargeDate("2026-01-31", 31)).toBe("2026-02-28");
    expect(nextChargeDate("2028-01-31", 29)).toBe("2028-02-29");
  });

  it("any other cadence: the gap in days", () => {
    expect(nextChargeDate("2026-10-14", 7)).toBe("2026-10-21");
    expect(nextChargeDate("2026-10-14", 27)).toBe("2026-11-10");
    expect(nextChargeDate("2026-10-14", 33)).toBe("2026-11-16");
    expect(nextChargeDate("2026-01-01", 365)).toBe("2027-01-01");
  });
});

describe("upcomingCharges", () => {
  it("the window is [today - 1, today + 7]", () => {
    expect(UPCOMING_GRACE_DAYS).toBe(1);
    expect(UPCOMING_HORIZON_DAYS).toBe(7);
    const u = upcomingCharges(
      input({
        planned: [
          plan("too-early", "2026-11-10", "1"),
          plan("yesterday", "2026-11-11", "1"),
          plan("today", "2026-11-12", "1"),
          plan("last", "2026-11-19", "1"),
          plan("too-late", "2026-11-20", "1"),
        ],
      }),
    );
    expect(u.rows.map((r) => [r.key, r.daysUntil])).toEqual([
      ["yesterday", -1],
      ["today", 0],
      ["last", 7],
    ]);
    const wider = upcomingCharges(
      input({ horizonDays: 8, planned: [plan("too-late", "2026-11-20", "1")] }),
    );
    expect(wider.rows).toHaveLength(1);
  });

  it("all three kinds, amounts negative, sorted by date then the larger outflow", () => {
    const u = upcomingCharges(
      input({
        recurring: [sub("Netflix", "2026-10-14", "60.00")],
        installments: [inst("Rata", "2026-11-14", "-3000.00")],
        planned: [plan("Ubezpieczenie", "2026-11-13", "1284")],
      }),
    );
    expect(u.rows.map((r) => [r.kind, r.key, r.when])).toEqual([
      ["planned", "Ubezpieczenie", "2026-11-13"],
      ["installment", "Rata", "2026-11-14"],
      ["subscription", "Netflix", "2026-11-14"],
    ]);
    eq(u.rows[0]?.amount, "-1284");
    eq(u.rows[1]?.amount, "-3000.00");
    eq(u.rows[2]?.amount, "-60.00");
    eq(u.totals.PLN, "-4344.00");
    expect(u.rows[1]?.payee).toBe("Rata");
  });

  it("coverage walks each account in date order; the first overrun and every later row are short", () => {
    const u = upcomingCharges(
      input({
        planned: [
          plan("p1", "2026-11-12", "60"),
          plan("p2", "2026-11-13", "50"),
          plan("p3", "2026-11-14", "5"),
          plan("s1", "2026-11-13", "500", { account: second }),
        ],
        balances: [bal("a1", "100"), bal("a2", "1000")],
      }),
    );
    const byKey = new Map(u.rows.map((r) => [r.key, r]));
    expect(byKey.get("p1")?.covered).toBe(true);
    expect(byKey.get("p1")?.shortfall).toBeNull();
    expect(byKey.get("p2")?.covered).toBe(false);
    eq(byKey.get("p2")?.shortfall, "10");
    expect(byKey.get("p3")?.covered).toBe(false);
    eq(byKey.get("p3")?.shortfall, "15");
    expect(byKey.get("s1")?.covered).toBe(true);
    expect(u.uncovered.map((r) => r.key)).toEqual(["p2", "p3"]);
  });

  it("exactly the balance is covered", () => {
    const u = upcomingCharges(
      input({ planned: [plan("p1", "2026-11-12", "100")], balances: [bal("a1", "100")] }),
    );
    expect(u.rows[0]?.covered).toBe(true);
  });

  it("unknown coverage: no account, no balance, or a balance in another currency", () => {
    const u = upcomingCharges(
      input({
        planned: [
          plan("none", "2026-11-12", "1", { account: null }),
          plan("nobal", "2026-11-12", "2", { account: second }),
          plan("eur", "2026-11-12", "3", { currency: "EUR" }),
        ],
        balances: [bal("a1", "0")],
      }),
    );
    expect(u.rows.map((r) => r.covered)).toEqual([null, null, null]);
    expect(u.rows.map((r) => r.shortfall)).toEqual([null, null, null]);
    expect(u.uncovered).toHaveLength(0);
  });

  it("totals per currency, never summed across", () => {
    const u = upcomingCharges(
      input({
        recurring: [sub("Spotify", "2026-10-14", "9.99", { currency: "EUR", account: null })],
        planned: [plan("p1", "2026-11-12", "100")],
      }),
    );
    expect(Object.keys(u.totals)).toEqual(["EUR", "PLN"]);
    eq(u.totals.EUR, "-9.99");
    eq(u.totals.PLN, "-100");
  });

  it("empty input", () => {
    const u = upcomingCharges(input({}));
    expect(u.rows).toEqual([]);
    expect(u.totals).toEqual({});
    expect(u.uncovered).toEqual([]);
  });
});
