// Cash pool rules (cash.py). Unit tests of the pure parts and the Python differential vectors of
// `budget-cash.jsonl` (legs, cash expenses, pool names); the net-worth half of tests/test_cash.py is
// in networth.test.ts. Synthetic data only.

import { describe, expect, it } from "vitest";
import { MANUAL_INSTITUTION } from "../core/index.js";
import { D, DecimalError } from "../decimal.js";
import { expectAll, loadVectors, Mismatches } from "../testing/vectors.js";
import {
  CASH_ACCOUNT_TYPE,
  CASH_LEG_PREFIX,
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

// ------------------------------------------------------------------ Python vectors

const ROWS = loadVectors("budget-cash").rows;
const kind = (k: string) => ROWS.filter((r) => r[0] === k);

/** Python `Decimal(str(x))`: InvalidOperation for text that is not a decimal. */
function parseOutcome(text: string): ReturnType<typeof D> | { error: string } {
  try {
    return D(text);
  } catch (error) {
    if (error instanceof DecimalError) return { error: error.signal };
    throw error;
  }
}

describe("cash vectors (Python cash.py on an in-memory DB)", () => {
  it("sync_cash_leg: the leg's columns and its pool", () => {
    const m = new Mismatches();
    for (const [, base, bankId, src, leg] of kind("leg") as [
      string,
      string,
      number,
      Record<string, string | null>,
      Record<string, unknown>,
    ][]) {
      const s = {
        bookingDate: src.booking_date as string,
        valueDate: src.value_date ?? null,
        amount: D(src.amount as string),
        currency: src.currency as string,
        description: src.description ?? null,
        reference: src.reference ?? null,
      };
      const f = cashLegFields(s, null);
      m.check(
        `leg ${bankId}`,
        {
          pool: [
            MANUAL_INSTITUTION,
            cashPoolName(s.currency, base || "PLN"),
            cashPoolExternalId(s.currency),
            CASH_ACCOUNT_TYPE,
            s.currency,
          ],
          booking_date: f.bookingDate,
          value_date: f.valueDate,
          amount: f.amount.toString(),
          currency: f.currency,
          counterparty_name: f.counterpartyName,
          description: f.description,
          reference: f.reference,
          dedup_hash: `${CASH_LEG_PREFIX}${bankId}`,
          category: f.category,
          category_source: f.categorySource,
        },
        {
          pool: leg.pool,
          booking_date: leg.booking_date,
          value_date: leg.value_date,
          amount: leg.amount,
          currency: leg.currency,
          counterparty_name: leg.counterparty_name,
          description: leg.description,
          reference: leg.reference,
          dedup_hash: leg.dedup_hash,
          category: leg.category,
          category_source: leg.category_source,
        },
      );
    }
    expectAll(m);
  });

  it("add_cash_expense: the stored amount or the error; FIX(Q14) non-finite inputs are refused", () => {
    const m = new Mismatches();
    let nonFinite = 0;
    for (const [, , text, want] of kind("expense") as [
      string,
      string,
      string,
      string | { error: string },
    ][]) {
      const parsed = parseOutcome(text);
      if ("error" in parsed && parsed.error === "NonFinite") {
        // Python stores NaN / -Infinity here (sNaN raises); the domain refuses at the parse.
        nonFinite++;
        m.check(text, typeof want !== "string" || /^-?(NaN|Infinity)$/.test(want), true);
        continue;
      }
      if ("error" in parsed) {
        m.check(text, parsed, want);
        continue;
      }
      const r = cashExpenseAmount(parsed);
      m.check(text, r.ok ? r.amount.toString() : { error: "ValueError" }, want);
    }
    expectAll(m);
    expect(nonFinite).toBe(6);
  });

  it("get_cash_account: bank, name, external id, type and currency per (currency, base)", () => {
    const m = new Mismatches();
    for (const [, currency, base, want] of kind("pool") as [
      string,
      string | null,
      string,
      string[],
    ][]) {
      const effectiveBase = base || "PLN"; // analytics.base_currency
      const cur = currency || effectiveBase; // `currency or base`: the command's default
      m.check(
        `${currency}/${base}`,
        [
          MANUAL_INSTITUTION,
          cashPoolName(cur, effectiveBase),
          cashPoolExternalId(cur),
          CASH_ACCOUNT_TYPE,
          cur,
        ],
        want,
      );
    }
    expectAll(m);
  });
});
