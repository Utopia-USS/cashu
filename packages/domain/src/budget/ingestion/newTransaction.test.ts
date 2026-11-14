import { describe, expect, it } from "vitest";
import { D } from "../../decimal.js";
import { toNewTransaction } from "./newTransaction.js";
import type { RawTransaction } from "./types.js";

describe("toNewTransaction (normalize.to_transaction)", () => {
  it("upper-cases the currency, normalises the counterparty account and keeps the rest", () => {
    const raw: RawTransaction = {
      bookingDate: "2026-09-01",
      valueDate: null,
      amount: D("-12.50"),
      currency: "pln",
      counterpartyName: "SKLEP",
      counterpartyIban: "'99 1050 0000",
      description: "D",
      reference: null,
      bankTransactionId: null,
      source: "csv",
      raw: { row: ["a", " b "] },
    };
    const t = toNewTransaction(raw, "h", 2);
    expect(t.currency).toBe("PLN");
    expect(t.counterpartyIban).toBe("9910500000");
    expect(t.amount.toString()).toBe("-12.50");
    expect([t.dedupHash, t.occurrence, t.raw]).toEqual(["h", 2, { row: ["a", " b "] }]);
    expect(toNewTransaction({ ...raw, counterpartyIban: "'" }, "h", 0).counterpartyIban).toBeNull();
  });
});
