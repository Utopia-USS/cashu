// A bank account's history before its first balance snapshot walks back over its own-currency rows
// only (data-safety rule 5): a row in another currency (a foreign or malformed event) is never
// subtracted from a balance in the account's currency. Synthetic data only.
//
// PLN checking, snapshot 1000.00 on 11-09; rows: 11-01 +200.00 PLN, 11-03 -50.00 EUR, 11-05 -100.00 PLN.
// Hand-computed end-of-day balances: 11-05 1000.00, 11-04 1100.00, 11-03 1100.00, 11-01 1100.00, and
// 900.00 before the first row. Walking the EUR row back too gave 1150.00 on 11-01..11-02 and 950.00.

import { describe, expect, it } from "vitest";
import {
  type BalanceSnapshot,
  builtinRegistry,
  type NetWorthAccount,
  netWorthSeries,
} from "../core/index.js";
import { D } from "../decimal.js";
import { bankBalanceContributor, type CashPoolTxn } from "./networth.js";

const BANK: NetWorthAccount = {
  id: "bank",
  type: "checking",
  currency: "PLN",
  active: true,
  removedAt: null,
};
const snapshot: BalanceSnapshot = { date: "2026-11-09", amount: D("1000.00"), source: "csv" };
const row = (bookingDate: string, amount: string, currency?: string): CashPoolTxn => ({
  account: "bank",
  bookingDate,
  amount: D(amount),
  ...(currency === undefined ? {} : { currency }),
});
const ROWS = [
  row("2026-11-01", "200.00", "PLN"),
  row("2026-11-03", "-50.00", "EUR"),
  row("2026-11-05", "-100.00", "PLN"),
];
const valuation = (rows: readonly CashPoolTxn[]) => {
  const v = bankBalanceContributor(rows, new Map([["bank", [snapshot]]])).valuations(
    new Map([["bank", BANK]]),
  );
  const out = v.get("bank");
  if (out === undefined) throw new Error("bank account not valued");
  return out;
};

describe("bank-account history before the first snapshot, per currency", () => {
  it("walks back over the account's own-currency rows only", () => {
    const v = valuation(ROWS);
    const at = (d: string) => v.at(d)?.toString() ?? null;
    expect(at("2026-11-09")).toBe("1000.00");
    expect(at("2026-11-05")).toBe("1000.00");
    expect(at("2026-11-04")).toBe("1100.00");
    expect(at("2026-11-03")).toBe("1100.00");
    expect(at("2026-11-02")).toBe("1100.00");
    expect(at("2026-11-01")).toBe("1100.00");
    expect(at("2026-10-31")).toBeNull();
    expect(v.axisDates()).toEqual(["2026-11-01", "2026-11-05", "2026-11-09"]);
  });

  it("values rows without a currency, or with the account's, exactly alike", () => {
    const own = ROWS.filter((t) => t.currency === "PLN");
    const bare = own.map(({ account, bookingDate, amount }) => ({ account, bookingDate, amount }));
    for (const d of ["2026-11-01", "2026-11-04", "2026-11-09"])
      expect(valuation(bare).at(d)?.toString()).toBe(valuation(own).at(d)?.toString());
  });

  it("keeps the PLN net-worth series free of the EUR row", () => {
    const series = netWorthSeries(
      {
        accounts: [BANK],
        balances: new Map([["bank", [snapshot]]]),
        contributors: [bankBalanceContributor(ROWS, new Map([["bank", [snapshot]]]))],
        types: builtinRegistry().accountTypes,
        today: "2026-11-10",
      },
      "PLN",
      "daily",
    ).map(([d, v]) => [d, v.toString()]);
    expect(series).toEqual([
      ["2026-11-01", "1100.00"],
      ["2026-11-05", "1000.00"],
      ["2026-11-09", "1000.00"],
    ]);
  });
});
