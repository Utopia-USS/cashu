// Python differential: `loan_valuation` (balances recorded before / after the terms, several per day,
// aware timestamps in other zones) probed at many dates (the retired Python `vectors_loans_assets.py`,
// loans-valuation.jsonl).

import { describe, it } from "vitest";
import { D } from "../decimal.js";
import { expectAll, loadVectors, Mismatches } from "../testing/vectors.js";
import { loanValuation } from "./valuation.js";

type Terms = [string, string, number, string, string | null, string];
type Case = [
  Terms,
  [string, string, string, string][],
  [string, string][],
  [string, string, string, string][],
];

const CASES = loadVectors("loans-valuation").rows as Case[];
const SLICE = 25;
const SLICES = Array.from({ length: Math.ceil(CASES.length / SLICE) }, (_, i) => i);

describe("loanValuation: Python differential", () => {
  it.each(SLICES)("cases slice %i", (slice) => {
    const m = new Mismatches();
    for (const [i, c] of CASES.slice(slice * SLICE, (slice + 1) * SLICE).entries()) {
      const [[principal, rate, months, start, origination, termsSet], balances, anchors, probes] =
        c;
      const v = loanValuation(
        {
          id: "l",
          accountId: "a",
          principal: D(principal),
          annualRate: D(rate),
          termMonths: months,
          startDate: start,
          originationDate: origination,
          updatedAt: termsSet,
          paymentIban: null,
          paymentText: null,
        },
        balances.map(([date, amount, recordedAt]) => ({ date, amount: D(amount), recordedAt })),
      );
      const label = `case ${slice * SLICE + i}`;
      m.check(
        `${label} anchors`,
        v.anchors.map(([d, a]) => [d, a.toString()]),
        anchors,
      );
      m.check(
        `${label} probes`,
        probes.map(([d]) => [d, v.at(d).toString(), v.scheduled(d).toString(), v.source(d)]),
        probes,
      );
    }
    expectAll(m);
  });
});
