// Cash pool rules (cash.ts): legs, cash expenses, pool names; the net-worth half is in networth.test.ts.
// Synthetic data only.

import { describe, expect, it } from "vitest";
import { D } from "../decimal.js";
import {
  CASH_ACCOUNT_TYPE,
  CASH_LEG_TEXT,
  type CategoryClaim,
  cashExpenseAmount,
  cashLegFields,
  cashPoolExternalId,
  cashPoolName,
  hasCashLeg,
  type LegSource,
  MANUAL_CATEGORY_SOURCE,
} from "./cash.js";

const MANUAL_WITHDRAWAL: CategoryClaim = {
  category: "cash_withdrawal",
  source: MANUAL_CATEGORY_SOURCE,
};

function source(fields: Partial<LegSource> = {}): LegSource {
  return {
    bookingDate: "2024-01-05",
    valueDate: null,
    amount: D("-200.00"),
    currency: "PLN",
    description: "WYPLATA W BANKOMACIE",
    reference: "WYPLATA W BANKOMACIE",
    ...fields,
  };
}

describe("hasCashLeg (D-24.3)", () => {
  // test_marking_withdrawal_feeds_pool_and_is_networth_neutral: marking makes the mirror.
  it("the owner's manual cash_withdrawal on a bank account makes a leg", () => {
    expect(hasCashLeg(MANUAL_WITHDRAWAL, "checking")).toBe(true);
  });

  // test_unmark_removes_mirror_and_reverts_source: clearing the claim drops the mirror (the revert of
  // the source row's category to `cash` is S09 / S24c).
  it("no claim, another category, or a rule's cash_withdrawal makes no leg", () => {
    expect(hasCashLeg(null, "checking")).toBe(false);
    expect(hasCashLeg({ category: "cash", source: MANUAL_CATEGORY_SOURCE }, "checking")).toBe(
      false,
    );
    expect(hasCashLeg({ category: "cash_withdrawal", source: "keyword" }, "checking")).toBe(false);
  });

  it("a row on a cash account never mirrors itself", () => {
    expect(hasCashLeg(MANUAL_WITHDRAWAL, CASH_ACCOUNT_TYPE)).toBe(false);
  });
});

describe("cashLegFields", () => {
  // test_marking_withdrawal_feeds_pool_and_is_networth_neutral: the mirror is +200.00 and the two
  // legs cancel.
  it("mirrors the withdrawal as a positive amount that cancels it", () => {
    const w = source();
    const leg = cashLegFields(w, null);
    expect(leg.amount.toString()).toBe("200.00");
    expect(w.amount.add(leg.amount).toString()).toBe("0.00");
    expect([leg.counterpartyName, leg.reference]).toEqual([CASH_LEG_TEXT, CASH_LEG_TEXT]);
    expect([leg.category, leg.categorySource]).toEqual(["cash_withdrawal", "cash_leg"]);
  });

  it("description falls back from reference to description to the literal; empty is falsy", () => {
    expect(cashLegFields(source({ reference: "R", description: "D" }), null).description).toBe("R");
    expect(cashLegFields(source({ reference: "", description: "D" }), null).description).toBe("D");
    expect(cashLegFields(source({ reference: null, description: "" }), null).description).toBe(
      CASH_LEG_TEXT,
    );
    expect(cashLegFields(source({ reference: " ", description: "D" }), null).description).toBe(" ");
  });

  it("a claim addressed to the leg sets its category and source", () => {
    const leg = cashLegFields(source(), { category: "dining", source: MANUAL_CATEGORY_SOURCE });
    expect([leg.category, leg.categorySource]).toEqual(["dining", MANUAL_CATEGORY_SOURCE]);
  });

  it("PARITY(Q10) / D-08.3: the amount is Python abs(), rounded to 28 digits", () => {
    const leg = cashLegFields(source({ amount: D("-1.014999999999999999999999999999") }), null);
    expect(leg.amount.toString()).toBe("1.015000000000000000000000000");
  });
});

describe("cashExpenseAmount and pool identity", () => {
  // test_cash_expense_draws_pool_and_counts_as_spend: amount=50 is stored as -50.
  it("is -abs(amount) whatever the sign; zero and -0 are refused", () => {
    const amount = (x: string) => {
      const r = cashExpenseAmount(D(x));
      return r.ok ? r.amount.toString() : r.reason;
    };
    expect([amount("50"), amount("-12.345"), amount("1E+2")]).toEqual(["-50", "-12.345", "-1E+2"]);
    for (const z of ["0", "-0", "0.00", "0E-9"]) {
      expect(cashExpenseAmount(D(z))).toEqual({ ok: false, reason: "zero_amount" });
    }
  });

  it("pool name: plain in the base currency, with the code otherwise; external id per currency", () => {
    expect(cashPoolName("PLN", "PLN")).toBe("Gotówka");
    expect(cashPoolName("EUR", "PLN")).toBe("Gotówka (EUR)");
    expect(cashPoolExternalId("EUR")).toBe("cash:EUR");
  });
});
