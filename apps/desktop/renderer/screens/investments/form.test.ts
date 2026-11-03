import { TxnType } from "@cashu/domain/investments";
import { setLanguageForTests } from "@cashu/i18n";
import { addUiManualTransaction } from "@cashu/store/investments/screen";
import { expect, it } from "vitest";
import {
  canonicalInvestmentDecimal,
  initialTransaction,
  transactionInput,
  transactionTypes,
} from "./usePortfolioForms.js";

it("keeps localized exact amounts while omitting stale fields after transaction-type changes", () => {
  setLanguageForTests("pl");
  const draft = {
    ...initialTransaction("2026-11-01"),
    account: "00000000-0000-8000-8000-000000000001",
    instrument: "00000000-0000-8000-8000-000000000002",
    currency: "USD",
    cashCurrency: "PLN",
    quantity: "2,5",
    price: "3,75",
    grossAmount: "9",
    fee: "1,5",
    tax: "0,2",
    cashAmount: "-10,25",
    fxRate: "4,123456789012345678",
    splitRatio: "2",
  };
  expect(transactionInput(draft, "2026-11-03")).toMatchObject({
    quantity: "2.5",
    price: "3.75",
    fxRate: "4.123456789012345678",
  });
  const split = transactionInput({ ...draft, type: "split" }, "2026-11-03");
  for (const key of [
    "quantity",
    "price",
    "grossAmount",
    "fee",
    "tax",
    "cashAmount",
    "cashCurrency",
    "fxRate",
  ])
    expect(split).not.toHaveProperty(key);
  const leg = transactionInput({ ...draft, type: "fx_conversion" }, "2026-11-03");
  expect(leg).toMatchObject({
    instrument: null,
    currency: "USD",
    cashCurrency: "USD",
    cashAmount: "-10.25",
  });
  for (const key of [
    "quantity",
    "price",
    "grossAmount",
    "fee",
    "tax",
    "fxRate",
    "splitRatio",
    "described",
  ])
    expect(leg).not.toHaveProperty(key);
  expect(addUiManualTransaction.input.safeParse(leg).success).toBe(true);
  expect(new Set(transactionTypes)).toEqual(new Set(Object.values(TxnType)));
});
it("preserves long localized decimal input and rejects a future transaction before submission", () => {
  expect(canonicalInvestmentDecimal("12 345,67890123456789")).toBe("12345.67890123456789");
  expect(() => canonicalInvestmentDecimal("1e5")).toThrow();
  expect(() => transactionInput(initialTransaction("2026-11-04"), "2026-11-03")).toThrow();
});
