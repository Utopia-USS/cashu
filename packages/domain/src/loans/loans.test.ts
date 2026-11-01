// Translation of tests/test_loans.py (many loans per profile, installment recognition, recorded balances
// vs the schedule) over an in-memory profile (`testing/netWorthProfile.ts`, the stand-in for the session).
// TODAY is fixed (Python reads date.today()). Not translated (HTTP / setup layers):
// test_loans_endpoint_lists_every_loan_with_a_name's `/api/loan` legacy alias (the summary part is here),
// test_loans_setup_steps (module setup state, S06b).

import { describe, expect, it } from "vitest";
import { builtinRegistry } from "../core/builtinModules.js";
import { notSubscriptionCategories, textRules } from "../core/modules.js";
import { netWorth, netWorthSeries } from "../core/networth.js";
import { D, type Decimal, decimalKey } from "../decimal.js";
import { budget } from "../index.js";
import { SyntheticProfile } from "../testing/netWorthProfile.js";
import { outstanding, schedule } from "./amortization.js";
import { paymentPatterns } from "./patterns.js";
import { loanSummary } from "./service.js";
import { loanValuation } from "./valuation.js";

const TODAY = "2026-10-01";
const LENDER = "99160000000000000000000999";
const registry = builtinRegistry();

/** Totals by value (Python compares Decimals by value: `Decimal("800000.00") == Decimal(800000)`). */
const totals = (p: SyntheticProfile) =>
  Object.fromEntries([...netWorth(p.book()).totals].map(([c, v]) => [c, decimalKey(v)]));

function scheduleOutstanding(
  principal: string,
  rate: string,
  months: number,
  start: string,
): Decimal {
  return outstanding(schedule(D(principal), D(rate), months, start), TODAY);
}

function twoLoans(p: SyntheticProfile) {
  const home = p.addLoan({
    name: "Hipoteka Test",
    type: "mortgage",
    principal: "400000",
    rate: "6.0",
    months: 300,
    start: "2025-01-05",
  });
  const car = p.addLoan({
    name: "Auto Test",
    principal: "60000",
    rate: "9.0",
    months: 72,
    start: "2025-03-01",
    iban: LENDER,
  });
  if (!home.ok || !car.ok) throw new Error("seed failed");
  return { home: home.value, car: car.value };
}

function messageOf(r: { ok: boolean; message?: string }): string {
  if (r.ok || r.message === undefined) throw new Error("expected a refusal");
  return r.message;
}

describe("test_loans.py", () => {
  it("test_many_loans_count_in_net_worth", () => {
    const p = new SyntheticProfile(TODAY);
    twoLoans(p);
    const { totals: t, lines } = netWorth(p.book());
    const expected = scheduleOutstanding("400000", "6.0", 300, "2025-01-05").add(
      scheduleOutstanding("60000", "9.0", 72, "2025-03-01"),
    );
    expect(decimalKey(t.get("PLN"))).toBe(decimalKey(expected.neg()));
    expect(lines.map((ln) => p.account(ln.account.id).name).sort()).toEqual([
      "Auto Test",
      "Hipoteka Test",
    ]);
    expect(new Set(lines.map((ln) => ln.account.type))).toEqual(new Set(["mortgage", "loan"]));
  });

  it("test_add_loan_twice_updates_it", () => {
    const p = new SyntheticProfile(TODAY);
    const terms = { name: "Auto Test", rate: "9.0", start: "2025-03-01" };
    p.addLoan({ ...terms, principal: "60000", months: 72 });
    p.addLoan({ ...terms, principal: "50000", rate: "8.0", months: 60 });
    const listed = p.listLoans();
    expect(listed).toHaveLength(1);
    const [loan, acc] = listed[0] as (typeof listed)[number];
    expect([loan.principal.toString(), loan.termMonths, acc.name]).toEqual([
      "50000",
      60,
      "Auto Test",
    ]);
    const bad = p.addLoan({
      name: "X",
      principal: "1",
      rate: "1",
      months: 1,
      start: "2025-01-01",
      type: "checking",
    });
    expect(messageOf(bad)).toMatch(/mortgage/);
  });

  it("test_loans_endpoint_lists_every_loan_with_a_name (summary per loan)", () => {
    const p = new SyntheticProfile(TODAY);
    const mortgage = p.addManualPosition(
      "Kredyt hipoteczny Test",
      "mortgage",
      "390000",
      "2026-06-01",
    );
    p.setLoan(mortgage.id, { principal: "400000", rate: "6.0", months: 300, start: "2025-01-05" });
    p.addLoan({
      name: "Auto Test",
      principal: "60000",
      rate: "9.0",
      months: 72,
      start: "2025-03-01",
      text: "RATA AUTO",
    });
    const recorded = (accountId: string) => p.balanceRows.filter((b) => b.accountId === accountId);
    const loans = p
      .listLoans()
      .map(([loan, account]) =>
        loanSummary(loan, account, loanValuation(loan, recorded(account.id)), TODAY, "PLN"),
      );
    expect(loans.map((x) => [x.name, x.type])).toEqual([
      ["Kredyt hipoteczny Test", "mortgage"],
      ["Auto Test", "loan"],
    ]);
    for (const x of loans) {
      expect(x.hasLoan && x.id && x.accountId).toBeTruthy();
      expect(x.balanceSource).toBe("schedule");
      expect(x.outstanding.toString()).toBe(x.scheduleOutstanding.toString());
      expect(x.summary.schedule.length === x.termMonths || x.summary.schedule.length > 0).toBe(
        true,
      );
    }
    expect(loans[1]?.paymentText).toBe("RATA AUTO");
  });

  it("test_a_balance_recorded_after_the_terms_wins_over_the_schedule", () => {
    const p = new SyntheticProfile(TODAY);
    const acc = p.addManualPosition("Hipoteka Test", "mortgage", "390000", "2026-06-01");
    const terms = { principal: "400000", rate: "6.0", months: 300, start: "2025-01-05" };
    p.setLoan(acc.id, terms);
    const scheduled = scheduleOutstanding("400000", "6.0", 300, "2025-01-05");
    // the add-position placeholder was recorded before the terms: superseded
    expect(totals(p)).toEqual({ PLN: decimalKey(scheduled.neg()) });

    const statementDay = "2026-06-01";
    p.setBalance(acc.id, statementDay, "380000"); // a bank statement
    const rows = schedule(D("400000"), D("6.0"), 300, "2025-01-05");
    const repaid = outstanding(rows, statementDay).sub(outstanding(rows, TODAY));
    expect(totals(p)).toEqual({ PLN: decimalKey(D("380000").sub(repaid).neg()) });
    // history: before the statement the schedule, from it on the recorded figure
    const series = new Map(netWorthSeries(p.book(), "PLN"));
    expect(decimalKey(series.get(statementDay))).toBe("-380000");

    // setting the terms again makes the schedule authoritative again
    p.setLoan(acc.id, terms);
    expect(totals(p)).toEqual({ PLN: decimalKey(scheduled.neg()) });
  });

  it("test_installments_are_loans_not_subscriptions", () => {
    const p = new SyntheticProfile(TODAY);
    const { car } = twoLoans(p);
    const bank = p.getOrCreateAccount({
      bank: "mbank",
      name: "mKonto",
      iban: "99114000000000000000000001",
    });
    const rows: budget.RecurringRow[] = [];
    const row = (
      date: string,
      amount: string,
      reference: string,
      name: string | null,
      iban: string | null,
    ) => ({
      bookingDate: date,
      currency: "PLN",
      decided: null,
      amount: D(amount),
      counterpartyName: name,
      counterpartyIban: iban,
      description: null,
      reference,
      isInternalTransfer: false,
    });
    for (const m of [6, 7, 8, 9]) {
      const mm = String(m).padStart(2, "0");
      // car loan: matched by the lender account only
      rows.push(row(`2026-${mm}-10`, "-1081.94", `PRZELEW ${mm}/2026`, "FINANSE TEST SA", LENDER));
      rows.push(row(`2026-${mm}-07`, "-43.00", "NETFLIX.COM", null, null)); // a real subscription
    }
    const categorized = () => {
      const ctx: budget.EngineContext = {
        ownIbans: new Set([bank.iban as string]),
        rules: new Map(),
        patterns: paymentPatterns(p.loanRows),
        moduleTextRules: textRules(registry),
      };
      const recurring = budget.detectRecurring(rows, ctx, notSubscriptionCategories(registry));
      const keys = budget.subscriptionPayees(recurring);
      const cats = new Map(
        rows.map((t) => [t.reference, budget.categorize(t, ctx, keys).category]),
      );
      return { cats, recurring };
    };
    const first = categorized();
    expect(first.cats.get("PRZELEW 06/2026")).toBe("loans");
    expect(first.cats.get("NETFLIX.COM")).toBe("subscriptions");
    expect(first.recurring.map((c) => c.counterparty)).toEqual(["NETFLIX.COM"]);
    // without the lender account the installment would look like a subscription
    p.setPaymentMatching(car.id, "");
    expect(categorized().cats.get("PRZELEW 06/2026")).toBe("subscriptions");
  });

  it("test_loans_are_per_profile", () => {
    const jan = new SyntheticProfile(TODAY);
    const ola = new SyntheticProfile(TODAY);
    twoLoans(jan);
    expect(jan.listLoans()).toHaveLength(2);
    expect(ola.listLoans()).toEqual([]);
    expect(totals(ola)).toEqual({});
    const [loan] = jan.listLoans()[0] as ReturnType<typeof jan.listLoans>[number];
    // Ola's rows never contain Jan's loan or account
    expect(ola.setPaymentMatching(loan.id, undefined, "X").ok).toBe(false);
    expect(
      ola.setLoan(loan.accountId, { principal: "1", rate: "1", months: 12, start: "2025-01-01" })
        .ok,
    ).toBe(false);
  });

  // --- R-01: loan terms attach only to an explicitly identified mortgage/loan account ---------

  it("test_a_loan_named_like_a_property_does_not_take_over_the_property", () => {
    const p = new SyntheticProfile(TODAY);
    const house = p.addManualPosition("Dom Test", "property", "800000");
    const r = p.addLoan({
      name: "Dom Test",
      type: "mortgage",
      principal: "300000",
      rate: "6.0",
      months: 300,
      start: "2025-01-05",
    });
    expect(messageOf(r)).toContain(`id ${house.id}, property`);
    expect(p.listLoans()).toEqual([]);
    expect(totals(p)).toEqual({ PLN: "800000" });
  });

  it("test_add_loan_attaches_to_an_account_given_by_id_or_exact_name", () => {
    const p = new SyntheticProfile(TODAY);
    const mortgage = p.addManualPosition("Kredyt Test", "mortgage", "1");
    p.addManualPosition("Dom Test", "property", "800000");
    const terms = { rate: "6.0", months: 300, start: "2025-01-05" };
    const loan = p.addLoan({
      account: { kind: "id", id: mortgage.id },
      principal: "300000",
      ...terms,
    });
    if (!loan.ok) throw new Error(loan.message);
    expect(loan.value.accountId).toBe(mortgage.id);
    const again = p.addLoan({
      account: { kind: "name", name: "Kredyt Test" },
      principal: "250000",
      ...terms,
    });
    if (!again.ok) throw new Error(again.message);
    expect(again.value.id).toBe(loan.value.id);
    expect(again.value.principal.toString()).toBe("250000");
    // an existing loan-type account of the same name is the one re-running updates
    const byName = p.addLoan({ name: "Kredyt Test", principal: "200000", ...terms });
    expect(byName.ok && byName.value.id).toBe(loan.value.id);
    expect(p.listLoans()).toHaveLength(1);
  });

  it.each(["Dom Test", "house-id"])("test_add_loan_refuses_a_non_loan_account[%s]", (ref) => {
    const p = new SyntheticProfile(TODAY);
    const house = p.addManualPosition("Dom Test", "property", "800000");
    const account =
      ref === "house-id"
        ? ({ kind: "id", id: house.id } as const)
        : ({ kind: "name", name: ref } as const);
    const r = p.addLoan({ account, principal: "1", rate: "1", months: 12, start: "2025-01-01" });
    expect(messageOf(r)).toMatch(/mortgage\/loan/);
  });

  it("test_add_loan_with_an_ambiguous_name_lists_the_candidates", () => {
    const p = new SyntheticProfile(TODAY);
    const manual = p.addManualPosition("Kredyt Test", "loan", "1");
    const bank = p.getOrCreateAccount({
      bank: "mbank",
      name: "Kredyt Test",
      externalId: "eb:kredyt-test",
      type: "loan",
    });
    const terms = { principal: "1", rate: "1", months: 12, start: "2025-01-01" };
    for (const target of [
      { name: "Kredyt Test" },
      { account: { kind: "name", name: "Kredyt Test" } as const },
    ]) {
      const message = messageOf(p.addLoan({ ...terms, ...target }));
      expect(message).toMatch(/ambiguous/);
      expect(message).toContain(`id ${manual.id}`);
      expect(message).toContain(`id ${bank.id}`);
    }
    const loan = p.addLoan({ ...terms, account: { kind: "id", id: bank.id } });
    expect(loan.ok && loan.value.accountId).toBe(bank.id);
  });

  it("test_add_loan_needs_exactly_one_of_name_and_account", () => {
    const p = new SyntheticProfile(TODAY);
    const terms = { principal: "1", rate: "1", months: 12, start: "2025-01-01" };
    expect(messageOf(p.addLoan(terms))).toMatch(/NAME/);
    expect(
      messageOf(p.addLoan({ ...terms, name: "A", account: { kind: "name", name: "B" } })),
    ).toMatch(/not both/);
    expect(
      messageOf(p.addLoan({ ...terms, account: { kind: "name", name: "Nope Test" } })),
    ).toMatch(/No account named/);
  });

  it("test_set_loan_refuses_a_property_account", () => {
    const p = new SyntheticProfile(TODAY);
    const house = p.addManualPosition("Dom Test", "property", "800000");
    const r = p.setLoan(house.id, {
      principal: "300000",
      rate: "6.0",
      months: 300,
      start: "2025-01-05",
    });
    expect(messageOf(r)).toMatch(/mortgage\/loan/);
  });

  it("test_net_worth_ignores_loan_terms_left_on_a_non_loan_account", () => {
    // Rows written before the fix (terms on a property) no longer replace its value.
    const p = new SyntheticProfile(TODAY);
    const house = p.addManualPosition("Dom Test", "property", "800000");
    p.writeTerms(house.id, { principal: "300000", rate: "6", months: 300, start: "2025-01-05" });
    expect(totals(p)).toEqual({ PLN: "800000" });
  });

  // --- R-11: a loan's own payment matching beats a cached (LLM) merchant rule -----------------

  function lenderInstallment() {
    const p = new SyntheticProfile(TODAY);
    const { car } = twoLoans(p);
    const bank = p.getOrCreateAccount({
      bank: "mbank",
      name: "mKonto",
      iban: "99114000000000000000000001",
    });
    const txn: budget.EngineTxn = {
      amount: D("-1081.94"),
      counterpartyName: "BANK TEST SA",
      counterpartyIban: LENDER,
      description: null,
      reference: "PRZELEW 06/2026",
      isInternalTransfer: false,
    };
    const mk = budget.merchantKey("BANK TEST SA", "PRZELEW 06/2026", null);
    const ctx = (rule: budget.MerchantRule): budget.EngineContext => ({
      ownIbans: new Set([bank.iban as string]),
      rules: new Map([[mk, rule]]),
      patterns: paymentPatterns(p.loanRows),
      moduleTextRules: textRules(registry),
    });
    return { p, car, txn, mk, ctx };
  }

  it("test_a_cached_llm_rule_does_not_beat_the_loans_payment_account", () => {
    const { p, car, txn, mk, ctx } = lenderInstallment();
    const rule: budget.MerchantRule = {
      merchantKey: mk,
      category: "subscriptions",
      source: "llm",
      locked: false,
    };
    expect(budget.categorize(txn, ctx(rule), new Set())).toEqual({
      category: "loans",
      source: "keyword",
    });
    // the same for the loan's title phrase
    p.setPaymentMatching(car.id, "", "PRZELEW 06/2026");
    expect(budget.categorize(txn, ctx(rule), new Set()).category).toBe("loans");
  });

  it("test_a_manual_merchant_rule_still_wins_over_the_loans_payment_account", () => {
    const { txn, mk, ctx } = lenderInstallment();
    const rule: budget.MerchantRule = {
      merchantKey: mk,
      category: "housing",
      source: "manual",
      locked: true,
    };
    expect(budget.categorize(txn, ctx(rule), new Set())).toEqual({
      category: "housing",
      source: "manual",
    });
  });
});
