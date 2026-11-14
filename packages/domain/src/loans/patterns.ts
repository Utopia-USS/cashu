/**
 * How the budget recognises loan installments (`modules/loans/patterns.py`, the `ModuleSpec`
 * categorization hooks).
 *
 * Installments are plain bank transfers, usually to a bank whose name says nothing about them;
 * without these hooks a monthly same-amount installment looks like a subscription. The phrases
 * apply to every profile; each loan can also name its lender account (`paymentIban`) or a title
 * phrase (`paymentText`).
 *
 * The phrases are Polish matching data, verbatim from Python (a byte-hash test guards them). They
 * are defined with the loans manifest in `core/builtinModules.ts` because the core registry is built
 * there and core may not import a module; this module is their public home.
 */

import { INSTALLMENT_PHRASES, LOANS_CATEGORY, type PaymentPattern } from "../core/index.js";
import { normalizeText } from "../text.js";

export { INSTALLMENT_PHRASES, LOANS_CATEGORY };

/** The fields of a loan the payment patterns read. */
export interface LoanPaymentMatching {
  readonly paymentIban: string | null;
  readonly paymentText: string | null;
}

/**
 * `payment_patterns`: one pattern per loan with a lender IBAN or a title phrase (empty strings count
 * as unset), the phrase normalized. `loans` = every loan of the profile's accounts in id order.
 */
export function paymentPatterns(loans: readonly LoanPaymentMatching[]): PaymentPattern[] {
  const out: PaymentPattern[] = [];
  for (const loan of loans) {
    if (loan.paymentIban || loan.paymentText) {
      out.push({
        category: LOANS_CATEGORY,
        counterpartyIban: loan.paymentIban || null,
        text: normalizeText(loan.paymentText) || null,
      });
    }
  }
  return out;
}
