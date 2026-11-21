// The currency picks of tests/test_budget_currency.py (the cashflow / spending / month close halves
// are budget analytics, S10).

import { describe, expect, it } from "vitest";
import {
  baseCurrencyOf,
  type CurrencyUse,
  defaultCurrency,
  orderCurrencyUses,
} from "./currency.js";

const use = (currency: string, transactions: number): CurrencyUse => ({
  currency,
  transactions,
  first: "2026-07-01",
  last: "2026-09-25",
});

describe("currency picks", () => {
  // test_eur_profile_currency_list_and_cash_pool
  it("a EUR-only profile lists EUR and defaults to it", () => {
    const codes = orderCurrencyUses([use("EUR", 13)], "EUR").map((c) => c.currency);
    expect(codes).toEqual(["EUR"]);
    expect(defaultCurrency("EUR", codes)).toBe("EUR");
  });

  // test_a_profile_with_only_foreign_data_defaults_to_its_data_currency
  it("a profile with only foreign data defaults to its data currency", () => {
    const codes = orderCurrencyUses([use("EUR", 13)], "PLN").map((c) => c.currency);
    expect(defaultCurrency("PLN", codes)).toBe("EUR");
  });

  // test_mixed_profile_lists_each_currency_on_its_own
  it("a mixed profile lists the base currency first", () => {
    // EUR has more transactions, the base currency still comes first.
    const codes = orderCurrencyUses([use("EUR", 400), use("PLN", 40)], "PLN").map(
      (c) => c.currency,
    );
    expect(codes).toEqual(["PLN", "EUR"]);
    expect(defaultCurrency("PLN", codes)).toBe("PLN");
  });

  it("other currencies follow by use, then by code; empty codes are dropped", () => {
    const rows = [use("NOK", 2), use("HUF", 2), use("EUR", 5), use("", 99)];
    expect(orderCurrencyUses(rows, "PLN").map((c) => c.currency)).toEqual(["EUR", "HUF", "NOK"]);
  });

  it("no data: the base currency", () => {
    expect(defaultCurrency("PLN", [])).toBe("PLN");
  });

  it("the base currency of no profile is PLN", () => {
    expect(baseCurrencyOf(null)).toBe("PLN");
    expect(baseCurrencyOf({ baseCurrency: null })).toBe("PLN");
    expect(baseCurrencyOf({ baseCurrency: "EUR" })).toBe("EUR");
  });
});
