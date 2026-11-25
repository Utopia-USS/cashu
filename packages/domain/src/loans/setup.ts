/**
 * The loans' blank-page steps (`modules/loans/setup.py`): the loan terms and, with the budget module,
 * recognising its installments among bank transactions. The store reads the facts.
 */

import { pick, type SetupContext, type SetupStep, setupStep, setupStrings } from "../core/index.js";
import { loansSetupStrings as S } from "./setup.strings.js";

/** What the loans steps read from the vault. */
export interface LoansSetupFacts {
  /** Loans of the profile's accounts (removed accounts too, as Python's account ids query). */
  readonly loans: number;
  /** Some loan has a payment IBAN or title phrase. */
  readonly paymentMatching: boolean;
  /** The budget module is enabled (installments are recognised in its transactions). */
  readonly budgetEnabled: boolean;
  /** Some transaction of the profile already carries the loans category. */
  readonly categorizedInstallments: boolean;
}

/** `setup_status` of the loans module. */
export function loansSetupSteps(facts: LoansSetupFacts, ctx: SetupContext): SetupStep[] {
  const { cli, lang } = ctx;
  const t = (text: { readonly pl: string; readonly en: string }) => pick(lang, text);
  const copy = t(setupStrings.copyCommand);
  const hasLoan = facts.loans > 0;
  const steps = [
    setupStep("loan", t(S.loanTitle), t(S.loanDescription), hasLoan, [
      {
        kind: "cli",
        label: copy,
        target: `${cli} loans add "${t(S.loanName)}" --type mortgage --principal 400000 --rate 6.5 --years 25 --start 2025-01-05`,
      },
    ]),
  ];
  // Installments are recognised in bank transactions: without the budget module there is nothing
  // to recognise them in (first steps L4).
  if (facts.budgetEnabled) {
    steps.push(
      setupStep(
        "payments",
        t(S.paymentsTitle),
        t(S.paymentsDescription),
        hasLoan && (facts.paymentMatching || facts.categorizedInstallments),
        [
          {
            kind: "cli",
            label: copy,
            target: `${cli} loans set-payment ${t(S.loanIdPlaceholder)} --text "RATA KREDYTU"`,
          },
        ],
      ),
    );
  }
  return steps;
}
