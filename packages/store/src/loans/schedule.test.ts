// The phone's loan page schedule: installments from the terms, the next one from today, and the
// paying account of a matched installment (payment IBAN or phrase, visible accounts). Synthetic data.
import { D, loans } from "@cashu/domain";
import { describe, expect, it } from "vitest";

import { createProfile } from "../core/commands.js";
import { importStatement, removeBankAccount } from "../index.js";
import { runQuery } from "../query.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { loanPayingAccount, loanSchedule } from "./screen.js";
import { createUiLoan, setUiLoanPayment } from "./ui-commands.js";

const LENDER = "PL61109010140000071219812874";

describe("loans.schedule", () => {
  it("lists the terms' installments, the next one from today and the IBAN-matched paying account", () => {
    const store = openTestStore();
    const env = testEnv();
    run(store, env, createProfile, {
      slug: "demo",
      name: "Demo",
      baseCurrency: "PLN",
      modules: ["loans", "budget"],
    });
    const created = run(store, env, createUiLoan, {
      name: "Synthetic mortgage",
      principal: "12000",
      annualRate: "6",
      termMonths: 12,
      startDate: "2026-01-31",
      originationDate: "2025-12-15",
    });
    if (!created.ok) throw new Error("synthetic loan refused");
    const loan = runQuery(store, loanSchedule, { loan: "unknown", today: "2026-03-15" }).value;
    expect(loan).toBeNull();
    const gid = store.read<{ gid: string }>("SELECT gid FROM loans")[0]?.gid ?? "";

    const view = runQuery(store, loanSchedule, { loan: gid, today: "2026-03-15" }).value;
    const expected = loans.schedule(D("12000"), D("6"), 12, "2026-01-31");
    expect(view?.rows).toEqual(expected);
    expect(view?.paid).toBe(2);
    expect(view?.next?.n).toBe(3);
    expect(view?.next?.date).toBe("2026-03-31");
    expect(view?.payingAccount).toBeNull();
    // On the installment's own day it is still the next one.
    expect(runQuery(store, loanSchedule, { loan: gid, today: "2026-03-31" }).value?.next?.n).toBe(
      3,
    );
    // After the last installment nothing is next.
    const done = runQuery(store, loanSchedule, { loan: gid, today: "2027-01-01" }).value;
    expect(done?.next).toBeNull();
    expect(done?.paid).toBe(12);

    expect(
      run(store, env, setUiLoanPayment, { account: created.value.account, iban: LENDER }).ok,
    ).toBe(true);
    expect(
      run(store, env, importStatement, {
        statement: {
          bank: "mbank",
          accountNumber: "PL10114000000000000000001234",
          accountName: "Synthetic joint account",
          currency: "PLN",
          transactions: [
            {
              bookingDate: "2026-02-28",
              valueDate: null,
              amount: D("-1032.80"),
              currency: "PLN",
              counterpartyName: "SYNTHETIC LENDER",
              counterpartyIban: LENDER,
              description: null,
              reference: "SYNTHETIC INSTALLMENT",
              bankTransactionId: null,
              source: "csv",
              raw: {},
            },
          ],
          balances: [],
          closingBalances: [],
        },
      }).ok,
    ).toBe(true);
    expect(
      runQuery(store, loanSchedule, { loan: gid, today: "2026-03-15" }).value?.payingAccount,
    ).toBe("Synthetic joint account");
    store.detach();
  });

  it("matches by the payment phrase too, and never names a removed account", () => {
    const store = openTestStore();
    const env = testEnv();
    run(store, env, createProfile, {
      slug: "demo",
      name: "Demo",
      baseCurrency: "PLN",
      modules: ["loans", "budget"],
    });
    const created = run(store, env, createUiLoan, {
      name: "Synthetic car loan",
      principal: "24000",
      annualRate: "8",
      termMonths: 24,
      startDate: "2026-01-20",
      originationDate: "2025-12-20",
    });
    if (!created.ok) throw new Error("synthetic loan refused");
    expect(
      run(store, env, setUiLoanPayment, { account: created.value.account, text: "rata auta" }).ok,
    ).toBe(true);
    const installment = (accountNumber: string, accountName: string, bookingDate: string) =>
      run(store, env, importStatement, {
        statement: {
          bank: "mbank",
          accountNumber,
          accountName,
          currency: "PLN",
          transactions: [
            {
              bookingDate,
              valueDate: null,
              amount: D("-1085.46"),
              currency: "PLN",
              counterpartyName: "SYNTHETIC CAR BANK",
              counterpartyIban: null,
              description: null,
              reference: "SYNTHETIC RATA AUTA 01",
              bankTransactionId: null,
              source: "csv",
              raw: {},
            },
          ],
          balances: [],
          closingBalances: [],
        },
      }).ok;
    expect(installment("PL10114000000000000000001234", "Synthetic main", "2026-01-20")).toBe(true);
    expect(installment("PL10124000000000000000003334", "Synthetic old", "2026-02-20")).toBe(true);
    const gid = store.read<{ gid: string }>("SELECT gid FROM loans")[0]?.gid ?? "";
    const read = store.read.bind(store);
    const loan = { paymentIban: null, paymentText: "rata auta" };
    const today = { loan: gid, today: "2026-03-01" };
    // phrase only: the newest matched installment's account
    expect(loanPayingAccount(read, loan)?.name).toBe("Synthetic old");
    expect(runQuery(store, loanSchedule, today).value?.payingAccount).toBe("Synthetic old");
    const old = store.read<{ gid: string }>(
      "SELECT gid FROM accounts WHERE name = ?",
      "Synthetic old",
    )[0]?.gid;
    expect(run(store, env, removeBankAccount, { account: old ?? "" }).ok).toBe(true);
    // the removed account is out of the budget: the older installment's account pays
    expect(loanPayingAccount(read, loan)).toMatchObject({ name: "Synthetic main" });
    expect(runQuery(store, loanSchedule, today).value?.payingAccount).toBe("Synthetic main");
    expect(loanPayingAccount(read, { paymentIban: null, paymentText: null })).toBeNull();
    store.detach();
  });
});
