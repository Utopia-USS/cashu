import {
  recordBalance,
  removeAccount,
  setLoan,
  setModules,
  setPaymentMatching,
} from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { decodeEntityRef } from "../runtime/refs.js";
import { bankAccount, bankTxn, callTool } from "../testing/budget.js";
import { nativeFixture } from "../testing/native.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
const fixture = () => {
  const f = nativeFixture({ modules: ["budget", "loans"] });
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
const terms = {
  principal: "1200",
  annualRate: "0",
  termMonths: 12,
  startDate: "2026-01-01",
  originationDate: "2025-12-15",
};
function loanAccount(f: ReturnType<typeof fixture>) {
  const account = bankAccount(f, "PLN", { name: "Private liability", type: "loan" });
  expect(
    f.run(setLoan, {
      account,
      ...terms,
      paymentText: "PRIVATE PAYMENT",
      paymentIban: "PL1234",
    }).ok,
  ).toBe(true);
  return account;
}
it("uses balances recorded after terms and preserves typed global identity under strict privacy", () => {
  const f = fixture();
  const a = bankAccount(f, "PLN", { type: "loan" });
  expect(f.run(recordBalance, { account: a, amount: "999", date: "2026-10-01" }).ok).toBe(true);
  f.advance(1000);
  expect(f.run(setLoan, { account: a, ...terms, paymentText: "PRIVATE PAYMENT" }).ok).toBe(true);
  const before = callTool(f.context(), "loans_summary").loans[0];
  expect(before).toMatchObject({
    outstanding: 100,
    monthly_payment: 100,
    balance_source: "schedule",
    months_elapsed: 11,
    remaining_months: 1,
  });
  f.advance(1000);
  expect(f.run(recordBalance, { account: a, amount: "-350", date: "2026-11-01" }).ok).toBe(true);
  const row = callTool(f.context(), "loans_summary").loans[0];
  expect(row).toMatchObject({
    outstanding: 350,
    balance_source: "recorded",
    annual_rate_pct: 0,
    principal: 1200,
    outstanding_share_of_principal: 0.291667,
  });
  expect(row.loan_id).toMatch(/^loan:/);
  expect(decodeEntityRef("loan", row.loan_id)).toMatch(/^[0-9a-f-]{36}$/);
  expect(row).not.toHaveProperty("payment_text");
  expect(row).not.toHaveProperty("name");
  const strict = callTool(f.context("strict"), "loans_summary").loans[0];
  expect(strict).not.toHaveProperty("outstanding");
  expect(strict.loan_id).toBe(row.loan_id);
  expect(strict.outstanding_share_of_principal).toBe(0.291667);
});
it("computes installment income share from three available months and handles disabled budget", () => {
  const f = fixture();
  loanAccount(f);
  const bank = bankAccount(f);
  bankTxn(f, bank, { amount: "100", date: "2026-08-01", merchant: "ZXQ INCOME" });
  bankTxn(f, bank, { amount: "200", date: "2026-09-01", merchant: "ZXQ INCOME" });
  bankTxn(f, bank, { amount: "300", date: "2026-10-01", merchant: "ZXQ INCOME" });
  expect(callTool(f.context(), "loans_summary").loans[0].installment_share_of_income).toBe(0.5);
  expect(f.run(setModules, { moduleIds: ["loans"] }).ok).toBe(true);
  const off = callTool(f.context(), "loans_summary");
  expect(off.loans[0].installment_share_of_income).toBeNull();
  expect(off.base_note).toBe("installment_share_of_income needs the budget module");
});
it("omits removed loans without renumbering the surviving account labels", () => {
  const f = fixture();
  const first = loanAccount(f);
  const second = loanAccount(f);
  expect(f.run(removeAccount, { account: first }).ok).toBe(true);
  const rows = callTool(f.context(), "loans_summary").loans;
  expect(rows).toHaveLength(1);
  expect(rows[0].account).toBe("mBank loan 2");
  expect(rows[0].installment_share_of_income).toBeNull();
  expect(f.run(removeAccount, { account: second }).ok).toBe(true);
  expect(callTool(f.context(), "loans_summary").loans).toEqual([]);
});
it("uses payment-pattern contributions to exclude installments from recurring payments", () => {
  const f = fixture();
  const liability = loanAccount(f);
  const bank = bankAccount(f);
  expect(f.run(setPaymentMatching, { account: liability, text: "RATA SYNTHETIC" }).ok).toBe(true);
  for (const date of ["2026-08-01", "2026-09-01", "2026-10-01"])
    bankTxn(f, bank, { amount: "-100", date, merchant: "ZXQ LENDER", reference: "RATA SYNTHETIC" });
  expect(callTool(f.context(), "recurring_payments").items).toEqual([]);
});
