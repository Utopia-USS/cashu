// Loans widget helpers (F7 FE9 / FE10) and the Przegląd monthly norm over complete months. Run with `npm test`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { incomeShare, rateText } from "../src/modules/loans/logic.ts";
import { closedMonthNorm } from "../src/core/util.ts";

test("FE9: the rate is a percent from the API, also below 1 %", () => {
  assert.equal(rateText(0.85), "0,85 %");
  assert.equal(rateText(7.25), "7,25 %");
  assert.equal(rateText(0), "0 %");
  assert.equal(rateText(null), null);
});

test("FE10: ratios divide by the average of complete months, never the running one", () => {
  const rows = [
    { label: "2026-07", income: 9000, expense: 8000, net: 1000 },
    { label: "2026-08", income: 9000, expense: 8800, net: 200 },
    { label: "2026-09", income: 9300, expense: 9000, net: 300 },
    { label: "2026-10", income: 0, expense: 1250, net: -1250 },
  ];
  const n = closedMonthNorm(rows, "2026-10-05");
  assert.equal(n.months, 3);
  assert.equal(n.income, 9100);
  assert.ok(Math.abs(n.expense - 8600) < 1e-9);
  assert.equal(closedMonthNorm([{ label: "2026-10", income: 100, expense: 50 }], "2026-10-05"), null);
  assert.equal(closedMonthNorm(null, "2026-10-05"), null);
  assert.equal(closedMonthNorm(rows, "2026-10-05", 1).expense, 9000);
  // liquid 52 000 / 8 600 = 6,0 months (not 41,6 with October's 1 250)
  assert.equal(Math.round((52000 / n.expense) * 10) / 10, 6);
  assert.equal(incomeShare(2900, n.income), 2900 / 9100);
  assert.equal(incomeShare(2900, null), null);
});

// ---- first steps (design/v3/first-steps sections 7-9) -------------------------------------------------------
import { annuity, capJoin, firstOfMonth, installmentCandidates, parseNum, paymentHint, termMonths, validateLoan } from "../src/modules/loans/logic.ts";

test("first steps: the annuity preview and the term in months", () => {
  // amortization.monthly_payment gives 2 700,83 (the note's 2 700,90 was rounded by hand)
  assert.equal(Math.round(annuity(400000, 6.5, 300) * 100) / 100, 2700.83);
  assert.equal(annuity(12000, 0, 12), 1000);
  assert.equal(termMonths(25, "years"), 300);
  assert.equal(termMonths(18, "months"), 18);
  assert.equal(parseNum("400 000"), 400000);
  assert.equal(parseNum("6,5"), 6.5);
  assert.equal(parseNum("abc"), null);
  assert.equal(firstOfMonth("2026-10-06"), "2026-10-01");
});

test("first steps: loan form validation in Polish", () => {
  const ok = { name: "Hipoteka", principal: 400000, rate: 6.5, term: 25, unit: "years", start: "2026-10-01", origination: "" };
  assert.deepEqual(validateLoan(ok), {});
  assert.deepEqual(validateLoan({ ...ok, rate: 0 }), {});
  assert.equal(validateLoan({ ...ok, name: "  " }).name, "Podaj nazwę.");
  assert.equal(validateLoan({ ...ok, principal: 0 }).principal, "Podaj kwotę większą od 0.");
  assert.equal(validateLoan({ ...ok, principal: null }).principal, "Podaj kwotę większą od 0.");
  assert.equal(validateLoan({ ...ok, rate: 101 }).rate, "Oprocentowanie od 0 do 100.");
  assert.equal(validateLoan({ ...ok, term: 0, unit: "months" }).term, "Okres od 1 do 600 miesięcy.");
  assert.equal(validateLoan({ ...ok, term: 601, unit: "months" }).term, "Okres od 1 do 600 miesięcy.");
  assert.equal(validateLoan({ ...ok, term: 51 }).term, "Okres od 1 do 50 lat.");
  assert.equal(validateLoan({ ...ok, start: "" }).start, "Podaj datę pierwszej raty.");
  assert.equal(validateLoan({ ...ok, origination: "2026-11-01" }).origination, "Wypłata nie może być po pierwszej racie.");
  assert.deepEqual(validateLoan({ ...ok, origination: "2026-09-15" }), {});
});

test("first steps: installment candidates are active monthly payments, largest first, 6 at most", () => {
  const it = (payee, amount, gap, active = true) => ({ payee, amount, currency: "PLN", count: 6, gap_days: gap, last: "2026-09-29", active });
  const items = [
    it("PZU", 156, 30), it("BANK HIPOTECZNY", 2700.9, 30), it("SPOTIFY", 23.99, 30), it("ROCZNA", 900, 365), it("STARE", 3000, 30, false),
    it("TYGODNIOWA", 50, 7), it("A", 10, 25), it("B", 11, 35), it("C", 12, 31), it("D", 13, 29),
  ];
  const c = installmentCandidates(items);
  assert.equal(c.length, 6);
  assert.deepEqual(c.map((x) => x.payee), ["BANK HIPOTECZNY", "PZU", "SPOTIFY", "D", "C", "B"]);
  assert.ok(!c.some((x) => x.payee === "STARE" || x.payee === "ROCZNA" || x.payee === "TYGODNIOWA"));
});

test("first steps: how the installments are recognised", () => {
  assert.equal(paymentHint({ payment_text: "RATA KREDYTU" }, false), "fraza „RATA KREDYTU\"");
  assert.equal(paymentHint({ payment_iban_tail: "1234" }, true), "IBAN …1234");
  assert.equal(paymentHint({}, true), "rozpoznane z wbudowanych fraz");
  assert.equal(paymentHint({}, false), null);
  assert.equal(capJoin(["a", "b"]), "a · b");
  assert.equal(capJoin(["a", "b", "c", "d"]), "a · b · +2");
});
