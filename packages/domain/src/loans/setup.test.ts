// Loans blank-page steps (modules/loans/setup.py) over their facts: the step halves of
// tests/test_first_steps_api.py test_loans_payment_step_needs_the_budget_module and
// test_payment_matching_by_phrase_and_iban (the state), tests/test_loans.py test_loans_setup_steps and
// tests/test_i18n_core_modules.py test_modules_and_setup_steps_in_english (loans).

import { describe, expect, it } from "vitest";
import { type SetupContext, setupView } from "../core/index.js";
import { type LoansSetupFacts, loansSetupSteps } from "./setup.js";

const NONE: LoansSetupFacts = {
  loans: 0,
  paymentMatching: false,
  budgetEnabled: false,
  categorizedInstallments: false,
};
const PL: SetupContext = { cli: "cashu --profile ola", lang: "pl" };
const view = (facts: Partial<LoansSetupFacts>, ctx = PL) =>
  setupView(loansSetupSteps({ ...NONE, ...facts }, ctx));

describe("loans setup steps", () => {
  it("test_loans_payment_step_needs_the_budget_module", () => {
    expect(view({}).steps.map((s) => s.id)).toEqual(["loan"]);
    const both = view({ budgetEnabled: true });
    expect(both.steps.map((s) => [s.id, s.title])).toEqual([
      ["loan", "Kredyt"],
      ["payments", "Rozpoznawanie rat"],
    ]);
    expect(view({ loans: 1 }).state).toBe("ready");
    expect(view({ loans: 1, budgetEnabled: true }).state).toBe("partial");
  });

  it("installments are recognised by a phrase or IBAN, or already categorized (test_loans_setup_steps)", () => {
    const base = { loans: 1, budgetEnabled: true };
    expect(view({ ...base, paymentMatching: true }).state).toBe("ready");
    const seeded = view({ ...base, categorizedInstallments: true });
    expect(seeded.steps.map((s) => s.status)).toEqual(["done", "done"]);
    // no loan yet: nothing to recognise, whatever the transactions say
    expect(view({ budgetEnabled: true, categorizedInstallments: true }).state).toBe("empty");
  });

  it("the commands", () => {
    const steps = view({ budgetEnabled: true }).steps;
    expect(steps[0]?.actions[0]?.target).toBe(
      'cashu --profile ola loans add "Hipoteka" --type mortgage --principal 400000 --rate 6.5 --years 25 --start 2025-01-05',
    );
    expect(steps[1]?.actions[0]?.target).toBe(
      'cashu --profile ola loans set-payment KREDYT_ID --text "RATA KREDYTU"',
    );
    expect(steps[1]?.description).toBe(
      "Fraza z tytułu przelewu albo IBAN banku; raty liczą się jako spłata, nie subskrypcja.",
    );
  });

  it("test_modules_and_setup_steps_in_english (loans)", () => {
    const steps = view({ budgetEnabled: true }, { cli: "cashu --profile jan", lang: "en" }).steps;
    expect(steps[0]?.title).toBe("Loan");
    expect(steps[0]?.actions[0]?.target).toContain('"Mortgage"');
    expect(steps[1]?.title).toBe("Recognizing installments");
    expect(steps[1]?.actions[0]?.target).toContain('LOAN_ID --text "RATA KREDYTU"');
    const texts = steps.flatMap((s) => [s.title, s.description]);
    expect(texts.some((t) => /[ąęółśżźćń—]/.test(t))).toBe(false);
  });
});
