import { expect, it } from "vitest";
import { Currencies, TxnType } from "../domain/index.js";
import {
  type AmountOutcome,
  cashFromGross,
  deriveAmounts,
  grossFromCash,
  signedCash,
  toCashCurrency,
  toTradeCurrency,
} from "./cash.js";
import { d } from "./testing/support.js";

// Translation of the "R5 amounts" section of tests/investments/importing/test_imp_dedup_ordering_cash.py
// (the dedup and ordering sections belong to scope S17c). A Python `pytest.raises(AmountError, match=m)`
// is an `ok: false` outcome whose message matches.
const { PLN: pln, USD: usd } = Currencies;

function value<T>(outcome: AmountOutcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.value;
}
const failure = (outcome: AmountOutcome<unknown>) => (outcome.ok ? null : outcome);
const same = (actual: { eq(other: ReturnType<typeof d>): boolean }, expected: string) =>
  actual.eq(d(expected));

it("derive cash across currencies uses fx_rate (R5)", () => {
  const amounts = value(
    deriveAmounts({
      txnType: TxnType.BUY,
      currency: usd,
      cashCurrency: pln,
      quantity: d("10"),
      price: d("100"),
      fee: d("1"),
      fxRate: d("4.0"),
    }),
  );
  expect(same(amounts.grossAmount, "1000") && same(amounts.cashAmount, "-4004")).toBe(true);
  const missing = failure(
    deriveAmounts({
      txnType: TxnType.BUY,
      currency: usd,
      cashCurrency: pln,
      quantity: d("1"),
      price: d("1"),
    }),
  );
  expect(missing?.message).toMatch(/fx_rate/);
  expect(missing?.kind).toBe("fx_missing");
  const dividend = value(
    deriveAmounts({
      txnType: TxnType.DIVIDEND,
      currency: usd,
      cashCurrency: pln,
      cash: d("40"),
      fxRate: d("4"),
    }),
  );
  expect(same(dividend.grossAmount, "10")).toBe(true);
  expect(
    failure(
      deriveAmounts({ txnType: TxnType.DIVIDEND, currency: usd, cashCurrency: pln, cash: d("40") }),
    )?.message,
  ).toMatch(/gross_amount is empty/);
});

it("derive amount rules", () => {
  const feeOnly = value(
    deriveAmounts({ txnType: TxnType.FEE, currency: pln, cashCurrency: pln, fee: d("2") }),
  );
  expect(same(feeOnly.grossAmount, "0") && same(feeOnly.cashAmount, "-2")).toBe(true);
  const split = value(deriveAmounts({ txnType: TxnType.SPLIT, currency: pln, cashCurrency: pln }));
  expect(same(split.grossAmount, "0") && same(split.cashAmount, "0")).toBe(true);
  expect(
    failure(deriveAmounts({ txnType: TxnType.BUY, currency: pln, cashCurrency: pln }))?.message,
  ).toMatch(/no amount/);
  expect(
    failure(
      deriveAmounts({
        txnType: TxnType.FX_CONVERSION,
        currency: pln,
        cashCurrency: pln,
        gross: d("5"),
      }),
    )?.message,
  ).toMatch(/fx_conversion rows need a cash_amount/);
  expect(same(value(grossFromCash(TxnType.SELL, d("98"), d("1"), d("1"))), "100")).toBe(true);
  expect(same(value(grossFromCash(TxnType.BUY, d("-102"), d("1"), d("1"))), "100")).toBe(true);
  expect(failure(grossFromCash(TxnType.BUY, d("-1"), d("2"), d("0")))?.message).toMatch(/exceed/);
  expect(same(value(cashFromGross(TxnType.DEPOSIT, d("5"), d("0"), d("0"))), "5")).toBe(true);
  expect(same(value(cashFromGross(TxnType.TRANSFER_IN, d("5"), d("0"), d("0"))), "0")).toBe(true);
  expect(same(value(toCashCurrency(d("0"), usd, pln, null)), "0"), "zero needs no rate").toBe(true);
  expect(value(toTradeCurrency(d("10"), usd, pln, d("3"))).toString()).toBe("3.3333333333");
});

it("signed cash", () => {
  expect(same(value(signedCash(TxnType.BUY, d("5"), true)), "-5")).toBe(true);
  expect(same(value(signedCash(TxnType.SELL, d("-5"), true)), "5")).toBe(true);
  expect(same(value(signedCash(TxnType.TRANSFER_IN, d("-5"), true)), "-5")).toBe(true);
  expect(same(value(signedCash(TxnType.BUY, d("5"), false)), "5")).toBe(true);
  expect(signedCash(TxnType.FX_CONVERSION, d("5"), true).ok).toBe(false);
});
