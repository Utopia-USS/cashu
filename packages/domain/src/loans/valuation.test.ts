// What a loan account owes on a date: the schedule, or a balance recorded after the terms less the
// principal the schedule repays after it. Synthetic terms only.

import { describe, expect, it } from "vitest";
import { D } from "../decimal.js";
import { type LoanTerms, loanValuation, type RecordedBalance } from "./valuation.js";

const LOAN: LoanTerms = {
  id: "l",
  accountId: "a",
  principal: D("120000"),
  annualRate: D("6"),
  termMonths: 120,
  startDate: "2025-02-05",
  originationDate: "2025-01-10",
  updatedAt: "2025-01-10 12:00:00",
  paymentIban: null,
  paymentText: null,
};
const bal = (date: string, amount: string, recordedAt: string): RecordedBalance => ({
  date,
  amount: D(amount),
  recordedAt,
});

describe("loanValuation", () => {
  it("without recorded balances the schedule decides", () => {
    const v = loanValuation(LOAN, []);
    expect(v.at("2025-01-01").isZero()).toBe(true); // before origination
    expect(v.at("2025-01-20").eq(D("120000"))).toBe(true);
    expect(v.at("2026-01-01").eq(v.scheduled("2026-01-01"))).toBe(true);
    expect(v.source("2026-01-01")).toBe("schedule");
  });

  it("a balance recorded before the terms were set is superseded and ignored", () => {
    const v = loanValuation(LOAN, [bal("2025-06-01", "-1", "2025-01-09 08:00:00")]);
    expect(v.anchors).toEqual([]);
  });

  it("a later balance anchors the value, less the principal repaid after it, never below zero", () => {
    const v = loanValuation(LOAN, [bal("2025-06-01", "-100000.00", "2025-06-02 10:00:00")]);
    expect(v.source("2025-05-31")).toBe("schedule");
    expect(v.source("2025-06-01")).toBe("recorded");
    expect(v.at("2025-06-01").toString()).toBe("100000.00"); // the magnitude of the stored sign
    const repaid = v.scheduled("2025-06-01").sub(v.scheduled("2026-06-01"));
    expect(v.at("2026-06-01").eq(D("100000.00").sub(repaid))).toBe(true);
    const tiny = loanValuation(LOAN, [bal("2025-06-01", "5.00", "2025-06-02 10:00:00")]);
    expect(tiny.at("2030-01-01").toString()).toBe("0.00");
  });

  it("per day the latest recording wins (later row on a tie); aware timestamps compare as UTC", () => {
    const v = loanValuation(LOAN, [
      bal("2025-06-01", "91000.00", "2025-06-02 09:00:00"),
      bal("2025-06-01", "90000.00", "2025-06-02T10:30:00+02:00"), // 08:30 UTC: older
      bal("2025-07-01", "80000.00", "2025-07-02 09:00:00"),
      bal("2025-07-01", "81000.00", "2025-07-02 09:00:00"),
    ]);
    expect(v.anchors.map(([d, a]) => [d, a.toString()])).toEqual([
      ["2025-06-01", "91000.00"],
      ["2025-07-01", "81000.00"],
    ]);
    expect(v.axisDates()).toEqual(["2025-06-01", "2025-07-01"]);
  });
});
