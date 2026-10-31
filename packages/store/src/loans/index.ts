// The loans store module: loan terms and payment matching. It contributes the loans' payment
// patterns to the budget's categorization (S24 4.2, Python `loans/patterns.py`) without the budget
// importing it.
import { normalizeText } from "@cashu/domain";
import { LOANS_CATEGORY, LOANS_MODULE } from "@cashu/domain/core";
import type { StoreModule } from "../registry.js";
import { LOANS, loansMaterializer } from "./loans.js";

export const loansModule: StoreModule = {
  id: "loans",
  materializers: [loansMaterializer],
  contributions: {
    reads: [LOANS],
    notSubscriptionCategories: LOANS_MODULE.notSubscriptionCategories,
    paymentPatterns: (sql) =>
      sql
        .all<{ payment_iban: string | null; payment_text: string | null }>(
          `SELECT payment_iban, payment_text FROM loans
           WHERE payment_iban IS NOT NULL OR payment_text IS NOT NULL ORDER BY id`,
        )
        .map((l) => ({
          category: LOANS_CATEGORY,
          counterpartyIban: l.payment_iban || null,
          text: normalizeText(l.payment_text) || null,
        })),
  },
};
