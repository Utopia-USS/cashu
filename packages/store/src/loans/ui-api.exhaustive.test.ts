/** Frozen results of the retired Python loan API validation; synthetic inputs only. */
import { expect, it } from "vitest";
import { createProfile } from "../core/commands.js";
import { runQuery } from "../query.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { loansScreen } from "./screen.js";
import { createUiLoan } from "./ui-commands.js";

const VALID = { ok: true, name: "Synthetic loan", currency: "EUR" } as const;
const INVALID = { ok: false } as const;
/** The Python `LoanCreate` + `_check(body, "EUR")` outcome of each case below, in order. */
const expected: readonly { ok: boolean; name?: string; currency?: string }[] = [
  VALID,
  VALID,
  INVALID,
  INVALID,
  INVALID,
  VALID,
  INVALID,
  INVALID,
  INVALID,
  INVALID,
  INVALID,
  INVALID,
  INVALID,
];
it("matches actual API name, currency, term, rate and date checks", () => {
  const base = {
    name: " Synthetic   loan ",
    principal: 12000,
    annual_rate: 6.5,
    term_months: 12,
    start_date: "2026-01-31",
    origination_date: null,
    currency: " eur ",
  };
  const cases = [
    {},
    { name: "\u0085Synthetic\u0085loan\u0085" },
    { principal: 0 },
    { principal: -1 },
    { annual_rate: -1 },
    { annual_rate: 100 },
    { annual_rate: 100.1 },
    { term_months: 0 },
    { term_months: 601 },
    { start_date: "2026-02-30" },
    { origination_date: "2026-02-01" },
    { currency: "EURO" },
    { name: "x".repeat(121) },
  ].map((patch) => ({ ...base, ...patch }));
  cases.forEach((input, index) => {
    const store = openTestStore();
    const env = testEnv();
    run(store, env, createProfile, {
      slug: "demo",
      name: "Demo",
      baseCurrency: "EUR",
      modules: ["loans"],
    });
    const result = run(store, env, createUiLoan, {
      name: input.name,
      principal: input.principal,
      annualRate: input.annual_rate,
      termMonths: input.term_months,
      startDate: input.start_date,
      originationDate: input.origination_date,
      currency: input.currency,
    });
    expect(result.ok, `case ${index}`).toBe(expected[index]?.ok);
    if (result.ok) {
      const row = runQuery(store, loansScreen, { today: "2026-03-01" }).value[0];
      expect(row?.name).toBe(expected[index]?.name);
      expect(row?.currency).toBe(expected[index]?.currency);
    }
    store.detach();
  });
});
