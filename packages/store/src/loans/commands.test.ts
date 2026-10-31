// Loans commands (S24 5): terms only on visible mortgage / loan accounts, add by name (a new manual
// account, re-run updates it, ambiguous and taken names refused), payment matching changing only
// the given fields (Python loans/service.py). Synthetic data only.
import { describe, expect, it } from "vitest";
import { createProfile, openAccount, removeAccount } from "../core/commands.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { addLoan, setLoan, setPaymentMatching } from "./commands.js";

const TERMS = {
  principal: "300000.00",
  annualRate: "6.27",
  termMonths: 360,
  startDate: "2026-01-10",
};

function setup() {
  const store = openTestStore();
  const env = testEnv();
  run(store, env, createProfile, {
    slug: "dom",
    name: "Dom",
    baseCurrency: "EUR",
    modules: ["loans"],
  });
  return { store, env };
}

describe("loans commands", () => {
  it("addLoan by name creates the account once; a re-run updates the terms", () => {
    const { store, env } = setup();
    const a = run(store, env, addLoan, {
      name: "Hipoteka",
      type: "mortgage",
      ...TERMS,
      paymentText: "  Rata kredytu ",
    });
    expect(a.ok && a.events.map((e) => e.type)).toEqual([
      "account.opened",
      "loan.termsSet",
      "loan.paymentMatchingSet",
    ]);
    const b = run(store, env, addLoan, { name: "Hipoteka", ...TERMS, principal: "290000.00" });
    expect(b.ok && b.events.map((e) => e.type)).toEqual(["loan.termsSet"]);
    expect(
      store.read(
        "SELECT a.currency, a.type, l.principal, l.payment_text FROM loans l JOIN accounts a ON a.id = l.account_id",
      ),
    ).toEqual([
      { currency: "EUR", type: "mortgage", principal: "290000.00", payment_text: "Rata kredytu" },
    ]);
  });

  it("refuses non-loan accounts, taken names, removed accounts", () => {
    const { store, env } = setup();
    const house = run(store, env, openAccount, {
      bank: "manual",
      name: "Dom",
      type: "property",
      currency: "PLN",
      externalId: "manual:Dom",
    });
    const account = house.ok ? house.value.account : "";
    expect(run(store, env, setLoan, { account, ...TERMS })).toEqual({
      ok: false,
      reason: "not_loan",
    });
    expect(run(store, env, addLoan, { name: "Dom", ...TERMS })).toEqual({
      ok: false,
      reason: "name_taken",
    });
    expect(run(store, env, addLoan, { ...TERMS })).toEqual({
      ok: false,
      reason: "name_or_account",
    });
    run(store, env, removeAccount, { account });
    expect(run(store, env, setLoan, { account, ...TERMS })).toEqual({
      ok: false,
      reason: "no_account",
    });
  });

  it("payment matching changes only the given fields; empty clears", () => {
    const { store, env } = setup();
    const a = run(store, env, addLoan, {
      name: "Auto",
      ...TERMS,
      paymentIban: "PL 61 1090 1014 0000 0712 1981 2874",
    });
    const account = a.ok ? a.value.account : "";
    run(store, env, setPaymentMatching, { account, text: "RATA" });
    expect(store.read("SELECT payment_iban, payment_text FROM loans")).toEqual([
      { payment_iban: "PL61109010140000071219812874", payment_text: "RATA" },
    ]);
    run(store, env, setPaymentMatching, { account, iban: "" });
    expect(store.read("SELECT payment_iban, payment_text FROM loans")).toEqual([
      { payment_iban: null, payment_text: "RATA" },
    ]);
    expect(
      run(store, env, setPaymentMatching, { account: "01JD0000000000000000000099", text: "x" }),
    ).toEqual({
      ok: false,
      reason: "no_loan",
    });
  });
});
