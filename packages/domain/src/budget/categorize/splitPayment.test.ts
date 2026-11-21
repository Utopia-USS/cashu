// Split-payment (MPP) VAT moves: the bank's move of an invoice's VAT from the main account to the
// owner's VAT account is a transfer, a supplier's split payment stays an expense. Synthetic titles.
import { describe, expect, it } from "vitest";
import { categorizeAll } from "./effective.js";
import { categorize, isSplitPaymentVatMove } from "./engine.js";
import { EMPTY_CONTEXT, titled } from "./testing/engineRows.js";
import { row } from "./testing/rows.js";
import { NOT_SUBSCRIPTION } from "./testing/scenarios.js";

const MPP = (vat: string) => `/VAT/${vat}/IDC/1234567890/INV/FV 7/11/2026/TXT/SYNTHETIC`;

describe("isSplitPaymentVatMove", () => {
  it("matches an outflow equal to the VAT amount of its MPP title", () => {
    expect(isSplitPaymentVatMove(titled("-230.00", MPP("230,00")))).toBe(true);
    expect(isSplitPaymentVatMove(titled("-230.00", MPP("230.00")))).toBe(true);
    expect(isSplitPaymentVatMove(titled("-230.00", MPP("230")))).toBe(true);
    expect(isSplitPaymentVatMove(titled("-230.00", MPP("230,00").toLowerCase()))).toBe(true);
  });

  it("leaves a supplier's split payment, an inflow and other titles alone", () => {
    expect(isSplitPaymentVatMove(titled("-1230.00", MPP("230,00")))).toBe(false); // gross paid
    expect(isSplitPaymentVatMove(titled("-230.01", MPP("230,00")))).toBe(false);
    expect(isSplitPaymentVatMove(titled("1230.00", MPP("230,00")))).toBe(false); // client pays
    expect(isSplitPaymentVatMove(titled("230.00", MPP("230,00")))).toBe(false);
    expect(isSplitPaymentVatMove(titled("-230.00", "/VAT/230,00/INV/FV 7"))).toBe(false);
    expect(isSplitPaymentVatMove(titled("-230.00", "PRZELEW VAT 230,00"))).toBe(false);
  });
});

describe("categorize: split-payment VAT moves", () => {
  it("files the VAT move as a transfer and the supplier payment by the usual rules", () => {
    const move = { ...titled("-230.00", MPP("230,00")), counterpartyName: "SYNTHETIC OWNER" };
    expect(categorize(move, EMPTY_CONTEXT, new Set())).toEqual({
      category: "transfer",
      source: "transfer",
    });
    const supplier = titled("-1230.00", MPP("230,00"), { cp: "SYNTHETIC SUPPLIER" });
    expect(categorize(supplier, EMPTY_CONTEXT, new Set()).category).not.toBe("transfer");
  });

  it("keeps the owner's manual category of the row", () => {
    const r = row({
      date: "2026-10-20",
      amount: "-230.00",
      reference: MPP("230,00"),
      claim: { category: "taxes", source: "manual_txn" },
    });
    const plain = row({ date: "2026-10-20", amount: "-230.00", reference: MPP("230,00") });
    const { results } = categorizeAll([r, plain], EMPTY_CONTEXT, NOT_SUBSCRIPTION);
    expect(results.get(r.key)).toMatchObject({ category: "taxes" });
    expect(results.get(plain.key)).toEqual({ category: "transfer", source: "transfer" });
  });
});
