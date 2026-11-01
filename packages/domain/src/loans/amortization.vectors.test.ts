// Python differential: `amortization.summarize` over random and edge terms
// (`parity/python/vectors_loans_assets.py`, loans-amortization.jsonl), the schedule compared through a
// sha256 digest of its rows plus its first and last row.

import { describe, it } from "vitest";
import { D } from "../decimal.js";
import { sha256Hex } from "../sha256.js";
import { expectAll, loadVectors, Mismatches } from "../testing/vectors.js";
import { type ScheduleRow, summarize } from "./amortization.js";

type Case = [string, string, number, string, string, string | null, Record<string, unknown>];

const CASES = loadVectors("loans-amortization").rows as Case[];
const SLICE = 25;
const SLICES = Array.from({ length: Math.ceil(CASES.length / SLICE) }, (_, i) => i);

const rowOut = (r: ScheduleRow) => [
  r.n,
  r.date,
  r.payment.toString(),
  r.interest.toString(),
  r.principal.toString(),
  r.balance.toString(),
];

describe("summarize: Python differential", () => {
  it.each(SLICES)("cases slice %i", (slice) => {
    const m = new Mismatches();
    for (const [i, c] of CASES.slice(slice * SLICE, (slice + 1) * SLICE).entries()) {
      const [principal, rate, months, start, asOf, origination, want] = c;
      const s = summarize(D(principal), D(rate), months, start, asOf, origination);
      const rows = s.schedule;
      const first = rows[0];
      const last = rows[rows.length - 1];
      m.check(
        `case ${slice * SLICE + i}`,
        {
          monthly_payment: s.monthlyPayment.toString(),
          outstanding: s.outstanding.toString(),
          months_elapsed: s.monthsElapsed,
          paid_principal: s.paidPrincipal.toString(),
          paid_interest: s.paidInterest.toString(),
          total_interest: s.totalInterest.toString(),
          remaining_interest: s.remainingInterest.toString(),
          payoff_date: s.payoffDate,
          rows: rows.length,
          first: first === undefined ? null : rowOut(first),
          last: last === undefined ? null : rowOut(last),
          digest: sha256Hex(rows.map((r) => `${rowOut(r).join("|")}\n`).join("")),
        },
        want,
      );
    }
    expectAll(m);
  });
});
