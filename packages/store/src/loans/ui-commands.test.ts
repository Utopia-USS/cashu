import { D, loans } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { createProfile, recordBalance, removeAccount, setModules } from "../core/commands.js";
import { importStatement } from "../index.js";
import { runQuery } from "../query.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { loansScreen } from "./screen.js";
import { createUiLoan, setUiLoanPayment } from "./ui-commands.js";

const terms = {
  name: "Synthetic mortgage",
  principal: "12000",
  annualRate: "0",
  termMonths: 12,
  startDate: "2026-01-31",
  originationDate: "2025-12-15",
};
function fixture() {
  const store = openTestStore();
  const env = testEnv();
  run(store, env, createProfile, {
    slug: "demo",
    name: "Demo",
    baseCurrency: "EUR",
    modules: ["loans", "budget"],
  });
  return { store, env };
}
describe("dashboard loans API boundary", () => {
  it("creates rather than upserts, normalizes names/currency, and keeps the actual opaque identity", () => {
    const { store, env } = fixture();
    const first = run(store, env, createUiLoan, {
      ...terms,
      name: " Synthetic   mortgage ",
      currency: " eur ",
    });
    expect(first.ok).toBe(true);
    expect(run(store, env, createUiLoan, terms)).toEqual({ ok: false, reason: "loan_name_taken" });
    const rows = runQuery(store, loansScreen, { today: "2026-02-28" }).value;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toMatch(/^\d+$/u);
    expect(rows[0]?.currency).toBe("EUR");
    expect(rows[0]?.summary.schedule[1]?.date).toBe("2026-02-28");
    expect(rows[0]?.monthlyPayment.eq(D("1000.00"))).toBe(true);
    store.detach();
  });
  it.each([
    { principal: "0" },
    { principal: "-1" },
    { annualRate: "100.1" },
    { annualRate: "-1" },
    { termMonths: 601 },
    { termMonths: 1.5 },
    { startDate: "2026-02-30" },
    { originationDate: "2026-02-01" },
    { name: " " },
    { name: "x".repeat(121) },
    { currency: "EURO" },
  ])("refuses invalid API terms before any append", (patch) => {
    const { store, env } = fixture();
    expect(run(store, env, createUiLoan, { ...terms, ...patch }).ok).toBe(false);
    expect(runQuery(store, loansScreen, { today: "2026-03-01" }).value).toEqual([]);
    store.detach();
  });
  it("clears explicit null fields, preserves absent ones and never returns the full lender number", () => {
    const { store, env } = fixture();
    const created = run(store, env, createUiLoan, terms);
    if (!created.ok) throw new Error("synthetic create failed");
    const account = created.value.account;
    const iban = "PL61109010140000071219812874";
    expect(run(store, env, setUiLoanPayment, { account, iban, text: "  TEST RATA  " }).ok).toBe(
      true,
    );
    let row = runQuery(store, loansScreen, { today: "2026-03-01" }).value[0];
    expect(row?.paymentText).toBe("TEST RATA");
    expect(row?.paymentIbanTail).toBe("2874");
    expect(JSON.stringify(row)).not.toContain(iban);
    expect(run(store, env, setUiLoanPayment, { account, text: null }).ok).toBe(true);
    row = runQuery(store, loansScreen, { today: "2026-03-01" }).value[0];
    expect(row?.paymentText).toBeNull();
    expect(row?.paymentIbanTail).toBe("2874");
    expect(run(store, env, setUiLoanPayment, { account, iban: null }).ok).toBe(true);
    expect(
      runQuery(store, loansScreen, { today: "2026-03-01" }).value[0]?.paymentIbanTail,
    ).toBeNull();
    for (const patch of [{}, { iban: "12" }, { text: "\u0301" }, { text: "x".repeat(201) }])
      expect(run(store, env, setUiLoanPayment, { account, ...patch }).ok).toBe(false);
    const other = fixture();
    expect(run(other.store, other.env, setUiLoanPayment, { account, text: "RATA" }).ok).toBe(false);
    other.store.detach();
    store.detach();
  });
  it("excludes removed loans and allows their name to be reused without reattaching terms", () => {
    const { store, env } = fixture();
    const a = run(store, env, createUiLoan, terms);
    if (!a.ok) throw new Error("synthetic create failed");
    run(store, env, removeAccount, { account: a.value.account });
    expect(runQuery(store, loansScreen, { today: "2026-03-01" }).value).toEqual([]);
    const b = run(store, env, createUiLoan, terms);
    expect(b.ok && b.value.account).not.toBe(a.value.account);
    store.detach();
  });
  it("uses the existing domain valuation and interest semantics for the full summary", () => {
    const { store, env } = fixture();
    const a = run(store, env, createUiLoan, { ...terms, annualRate: "6.5" });
    if (!a.ok) throw new Error("synthetic create failed");
    const row = runQuery(store, loansScreen, { today: "2026-03-01" }).value[0];
    const expected = loans.summarize(
      D(terms.principal),
      D("6.5"),
      12,
      terms.startDate,
      "2026-03-01",
      terms.originationDate,
    );
    expect(row?.summary).toEqual(expected);
    expect(row?.paidInterest.eq(expected.paidInterest)).toBe(true);
    env.advance(1000);
    run(store, env, recordBalance, {
      account: a.value.account,
      amount: "8000",
      date: "2026-03-01",
      source: "manual",
    });
    const anchored = runQuery(store, loansScreen, { today: "2026-03-01" }).value[0];
    expect(anchored?.balanceSource).toBe("recorded");
    expect(anchored?.outstanding.eq(D("8000"))).toBe(true);
    store.detach();
  });
  it("rederives actual categories and matched counts after phrase changes and clears; budget-disabled matches nothing", () => {
    for (const budgetOn of [true, false]) {
      const { store, env } = fixture();
      if (!budgetOn) run(store, env, setModules, { moduleIds: ["loans"] });
      const a = run(store, env, createUiLoan, terms);
      if (!a.ok) throw new Error("synthetic create failed");
      const transactions = ["-20", "0", "20"].map((amount, i) => ({
        bookingDate: "2026-01-05",
        valueDate: null,
        amount: D(amount),
        currency: "PLN",
        counterpartyName: "SYNTHETIC LENDER",
        counterpartyIban: null,
        description: null,
        reference: `PAYMENT ${i}`,
        bankTransactionId: null,
        source: "csv",
        raw: {},
      }));
      expect(
        run(store, env, importStatement, {
          statement: {
            bank: "mbank",
            accountNumber: "PL10114000000000000000001234",
            accountName: "Synthetic account",
            currency: "PLN",
            transactions,
            balances: [],
            closingBalances: [],
          },
        }).ok,
      ).toBe(true);
      expect(
        run(store, env, setUiLoanPayment, { account: a.value.account, text: "SYNTHETIC LENDER" })
          .ok,
      ).toBe(true);
      const read = () => runQuery(store, loansScreen, { today: "2026-03-01" }).value[0];
      expect(read()?.matched).toBe(budgetOn ? 2 : 0);
      if (budgetOn)
        expect(
          store.read<{ category: string }>(
            "SELECT category FROM transactions WHERE amount = '-20'",
          )[0]?.category,
        ).toBe("loans");
      expect(run(store, env, setUiLoanPayment, { account: a.value.account, text: null }).ok).toBe(
        true,
      );
      expect(read()?.matched).toBe(0);
      if (budgetOn)
        expect(
          store.read<{ category: string }>(
            "SELECT category FROM transactions WHERE amount = '-20'",
          )[0]?.category,
        ).not.toBe("loans");
      store.detach();
    }
  });
});
