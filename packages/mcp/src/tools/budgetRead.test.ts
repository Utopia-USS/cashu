import {
  addCashExpense,
  type Command,
  deleteCashTransaction,
  removeAccount,
  setMerchantCategory,
  setModules,
} from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import * as L from "../privacy/labels.js";
import { pyDumps } from "../privacy/pyJson.js";
import { Redactor } from "../privacy/redactor.js";
import { bankAccount, bankTxn, callTool } from "../testing/budget.js";
import { nativeFixture } from "../testing/native.js";
import { budgetTools } from "./budget.js";

const fixtures: ReturnType<typeof nativeFixture>[] = [];
const fixture = () => {
  const f = nativeFixture();
  fixtures.push(f);
  return f;
};
afterEach(() => {
  for (const f of fixtures.splice(0)) f.close();
});
async function setCategory(
  f: ReturnType<typeof nativeFixture>,
  merchant: string,
  category: string,
) {
  const ctx = f.context("strict");
  const spec = budgetTools().find((tool) => tool.name === "set_merchant_category");
  if (!spec) throw new Error("missing setter");
  const output = new Redactor({ privacy: ctx.privacy, guard: ctx.guard }).apply(
    await spec.handler(ctx, { merchant, category }),
  );
  return JSON.parse(pyDumps(output)) as Record<string, unknown>;
}
it("learns only a unique in-vault merchant and preserves an owner pin", async () => {
  const f = fixture();
  const other = fixture();
  const a = bankAccount(f);
  const b = bankAccount(other);
  bankTxn(f, a, { amount: "-10", merchant: "ZXQ SETTER TEST" });
  bankTxn(f, a, { amount: "-20", merchant: "ZXQ SETTER TEST", currency: "EUR" });
  bankTxn(other, b, { amount: "-30", merchant: "ZXQ OTHER TEST" });
  const before = f.committed();
  await expect(setCategory(f, "ZXQ OTHER TEST", "dining")).rejects.toThrow("no such merchant");
  await expect(setCategory(f, "ZXQ SETTER TEST", "invalid-category")).rejects.toThrow(
    "unknown category",
  );
  expect(f.committed()).toBe(before);
  expect(await setCategory(f, "ZXQ SETTER TEST", "dining")).toMatchObject({
    updated_transactions: 2,
  });
  expect(await setCategory(f, "ZXQ SETTER TEST", "dining")).toMatchObject({
    updated_transactions: 0,
  });
  expect(other.store.read("SELECT * FROM category_rules")).toHaveLength(0);
  expect(
    f.run(setMerchantCategory, { merchantKey: "ZXQ SETTER TEST", category: "shopping" }).ok,
  ).toBe(true);
  expect(await setCategory(f, "ZXQ SETTER TEST", "dining")).toMatchObject({
    category: "shopping",
    updated_transactions: 0,
    rule: "kept: the owner set this merchant's category by hand",
  });
});
it("accepts only unique redacted display or this vault's guard token", async () => {
  const f = fixture();
  const other = nativeFixture({ vault: "22222222222222222222222222222222" });
  fixtures.push(other);
  const a = bankAccount(f);
  const b = bankAccount(other);
  bankTxn(f, a, { amount: "-10", merchant: "ZXQ 123456789012 TEST" });
  bankTxn(f, a, { amount: "-20", merchant: "ZXQ 987654321098 TEST" });
  bankTxn(f, a, { amount: "-30", merchant: "Piotr Kowalski" });
  bankTxn(other, b, { amount: "-40", merchant: "Piotr Kowalski" });
  const ctx = f.context("strict");
  const display = new Redactor({ privacy: ctx.privacy, guard: ctx.guard }).apply(
    L.merchant("ZXQ 123456789012 TEST"),
  ) as string;
  const before = f.committed();
  await expect(setCategory(f, display, "dining")).rejects.toThrow("no such merchant");
  await expect(
    setCategory(f, other.context("strict").guard.payeeRef("Piotr Kowalski"), "dining"),
  ).rejects.toThrow("no such merchant");
  expect(f.committed()).toBe(before);
  const token = ctx.guard.payeeRef("Piotr Kowalski");
  expect(token).toMatch(/^payee:/);
  expect(await setCategory(f, token, "dining")).toMatchObject({ updated_transactions: 1 });
});
it("refuses a merchant removed while its setter waits to execute", async () => {
  const f = fixture();
  const added = f.run(addCashExpense, {
    amount: "10",
    title: "ZXQ STALE TEST",
    category: "dining",
  });
  if (!added.ok) throw new Error(added.reason);
  const ctx = f.context("strict");
  const store = {
    ...ctx.store,
    run: async <I, R>(command: Command<I, R>, input: unknown) => {
      const removed = f.run(deleteCashTransaction, { txn: added.value.txn });
      if (!removed.ok) throw new Error(removed.reason);
      return ctx.store.run(command, input);
    },
  };
  const spec = budgetTools().find((tool) => tool.name === "set_merchant_category");
  if (!spec) throw new Error("missing setter");
  await expect(
    spec.handler(
      { ...ctx, store },
      {
        merchant: "ZXQ STALE TEST",
        category: "shopping",
      },
    ),
  ).rejects.toThrow("no such merchant");
  expect(f.store.read("SELECT * FROM category_rules")).toHaveLength(0);
});
it("reports empty periods and zero cashflow without invented values", () => {
  const f = fixture();
  expect(callTool(f.context(), "spending_breakdown")).toMatchObject({
    period: null,
    total: 0,
    categories: [],
    top_merchants: [],
  });
  expect(callTool(f.context(), "cashflow_summary")).toMatchObject({
    months: 0,
    savings_rate: null,
    income_expense_ratio: null,
    monthly: [],
    income: 0,
    expense: 0,
  });
  expect(callTool(f.context(), "recurring_payments").items).toEqual([]);
  expect(callTool(f.context(), "uncategorized_merchants").categories).toContain("groceries");
  expect(f.committed()).toBe(0);
});
it("keeps spending filters, first-seen ties and the denominator before top", () => {
  const f = fixture();
  const account = bankAccount(f);
  bankTxn(f, account, { amount: "-20", merchant: "ZXQ FIRST", category: "groceries" });
  bankTxn(f, account, { amount: "-20", merchant: "ZXQ SECOND", category: "shopping" });
  bankTxn(f, account, { amount: "-10", category: "groceries" });
  bankTxn(f, account, { amount: "-999", merchant: "ZXQ MOVE", category: "transfer" });
  bankTxn(f, account, { amount: "-888", merchant: "ZXQ CASH", category: "cash_withdrawal" });
  bankTxn(f, account, { amount: "100", merchant: "ZXQ SALARY" });
  const usd = bankAccount(f, "USD");
  bankTxn(f, usd, { amount: "-777", currency: "USD", merchant: "ZXQ USD" });
  const result = callTool(f.context(), "spending_breakdown", { top: 1 });
  expect(result).toMatchObject({ currency: "PLN", period: "2026-10", total: 50 });
  expect(result.categories).toMatchObject([
    { category: "groceries", amount: 30, share: 0.6 },
    { category: "shopping", amount: 20, share: 0.4 },
  ]);
  expect(result.top_merchants).toEqual([
    { merchant: "ZXQ FIRST", share: 0.4, count: 1, amount: 20 },
  ]);
  expect(f.run(removeAccount, { account }).ok).toBe(true);
  expect(callTool(f.context(), "spending_breakdown").total).toBe(50);
});
it("defaults period across currencies and parses Python-compatible digits", () => {
  const f = fixture();
  const a = bankAccount(f);
  const usd = bankAccount(f, "USD");
  bankTxn(f, a, { amount: "-10", merchant: "ZXQ PERIOD" });
  bankTxn(f, usd, { amount: "-1", currency: "USD", date: "2026-11-01", merchant: "ZXQ USD" });
  expect(callTool(f.context(), "spending_breakdown")).toMatchObject({
    period: "2026-11",
    total: 0,
  });
  for (const period of ["2026", "2026-Q4", "٢٠٢٦-١٠"])
    expect(callTool(f.context(), "spending_breakdown", { period }).total).toBe(10);
  expect(() => callTool(f.context(), "spending_breakdown", { period: "2026-13" })).toThrow(
    "month must be 01-12",
  );
  expect(() => callTool(f.context(), "spending_breakdown", { period: "2026-Q5" })).toThrow(
    "period must look like",
  );
  expect(() => callTool(f.context(), "spending_breakdown", { currency: "   " })).toThrow(
    "currency must be a 3-letter code",
  );
  expect(
    callTool(f.context(), "spending_breakdown", { currency: "pln", period: "2026" }).currency,
  ).toBe("PLN");
});
it("redacts private payees but keeps shares", () => {
  const f = fixture();
  const a = bankAccount(f);
  bankTxn(f, a, { amount: "-40", merchant: "Piotr Kowalski", iban: "PL5678" });
  const result = callTool(f.context("strict"), "spending_breakdown");
  expect(result).not.toHaveProperty("total");
  expect(result.top_merchants[0]).toMatchObject({
    merchant: expect.stringMatching(/^payee:/),
    share: 1,
    count: 1,
  });
  expect(result.top_merchants[0]).not.toHaveProperty("amount");
  expect(JSON.stringify(result)).not.toContain("KOWALSKI");
});
it("uses returned months for averages and null ratios for zero denominators", () => {
  const f = fixture();
  const a = bankAccount(f);
  bankTxn(f, a, { amount: "900", date: "2026-08-01", merchant: "ZXQ INCOME" });
  bankTxn(f, a, { amount: "100", date: "2026-09-01", merchant: "ZXQ INCOME" });
  bankTxn(f, a, { amount: "-50", date: "2026-09-02", merchant: "ZXQ EXPENSE" });
  bankTxn(f, a, { amount: "-150", date: "2026-10-01", merchant: "ZXQ OTHER" });
  const result = callTool(f.context(), "cashflow_summary", { months: 2 });
  expect(result).toMatchObject({
    months: 2,
    income: 100,
    expense: 200,
    savings_rate: -1,
    income_expense_ratio: 0.5,
    deficit_months: ["2026-10"],
  });
  expect(result.monthly).toMatchObject([
    { expense_vs_average: 0.5, savings_rate: 0.5 },
    { expense_vs_average: 1.5, savings_rate: null, deficit: true },
  ]);
  expect(
    callTool(f.context(), "cashflow_summary", { currency: "USD" }).income_expense_ratio,
  ).toBeNull();
});
it("orders unknowns by count then amount and computes shares before limit", () => {
  const f = fixture();
  const a = bankAccount(f);
  for (const date of ["2026-09-01", "2026-10-01"])
    bankTxn(f, a, { amount: "-10", date, merchant: "ZXQ TWICE" });
  bankTxn(f, a, { amount: "-50", merchant: "ZXQ ONCE" });
  bankTxn(f, a, { amount: "-999", merchant: "ZXQ DECIDED", category: "groceries" });
  const result = callTool(f.context(), "uncategorized_merchants", { limit: 1 });
  expect(result.merchants).toEqual([
    { merchant: "ZXQ TWICE", currency: "PLN", count: 2, share: 0.285714, total: 20 },
  ]);
  expect(callTool(f.context("strict"), "uncategorized_merchants").merchants[0]).not.toHaveProperty(
    "total",
  );
});
it("returns active and inactive recurring candidates with three-row averages", () => {
  const f = fixture();
  const a = bankAccount(f);
  for (const date of ["2026-08-01", "2026-09-01", "2026-10-01"])
    bankTxn(f, a, { amount: "-30", date, merchant: "ZXQ CURRENT" });
  for (const date of ["2026-01-01", "2026-02-01", "2026-03-01"])
    bankTxn(f, a, { amount: "-20", date, merchant: "ZXQ OLD" });
  bankTxn(f, a, { amount: "500", date: "2026-11-01", merchant: "ZXQ INCOME" });
  const result = callTool(f.context(), "recurring_payments");
  expect(result.items).toHaveLength(2);
  expect(
    result.items.find((row: { merchant: string }) => row.merchant === "ZXQ CURRENT"),
  ).toMatchObject({
    active: true,
    occurrences: 3,
    months_covered: 3,
    typical_amount: 30,
    share_of_monthly_spending: 1.5,
  });
  expect(
    result.items.find((row: { merchant: string }) => row.merchant === "ZXQ OLD"),
  ).toMatchObject({ active: false, typical_amount: 20 });
  expect(callTool(f.context("strict"), "recurring_payments").items[0]).not.toHaveProperty(
    "typical_amount",
  );
});
it("uses existing argument and module validation", () => {
  const f = fixture();
  expect(() => callTool(f.context(), "cashflow_summary", { months: 0 })).toThrow();
  expect(() => callTool(f.context(), "uncategorized_merchants", { limit: true })).toThrow();
  expect(f.run(setModules, { moduleIds: [] }).ok).toBe(true);
  expect(() => callTool(f.context(), "spending_breakdown")).toThrow("tool disabled");
});
