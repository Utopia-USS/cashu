/**
 * The budget's blank-page steps (`modules/budget/setup.py`): first statement, expense categories,
 * transfers between accounts. The store counts the facts; this file turns them into steps.
 */

import { pick, type SetupContext, type SetupStep, setupStep, setupStrings } from "../core/index.js";
import { budgetSetupStrings as S } from "./setup.strings.js";

/** What the budget steps read from the vault (counts over the profile's bank accounts). */
export interface BudgetSetupFacts {
  /** Accounts of a bank (not the manual institution), removed ones included. */
  readonly bankAccounts: number;
  /** Transactions of those accounts. */
  readonly transactions: number;
  /** Outflows of those accounts still in the default category. */
  readonly uncategorized: number;
  /** Manual merchant rules plus transactions categorized by hand. */
  readonly manualDecisions: number;
  /** Transactions of those accounts matched as internal transfers. */
  readonly internalTransfers: number;
  /** Transactions of those accounts in the transfer category (own moves the IBAN match cannot pair). */
  readonly ownMoves: number;
}

/** `setup_status` of the budget module. */
export function budgetSetupSteps(facts: BudgetSetupFacts, ctx: SetupContext): SetupStep[] {
  const { cli, lang } = ctx;
  const t = (text: { readonly pl: string; readonly en: string }) => pick(lang, text);
  const hasData = facts.transactions > 0;
  // One bank account: nothing to pair, the step is done once there is data (first steps B1).
  const single = hasData && facts.bankAccounts < 2;
  const copy = t(setupStrings.copyCommand);
  return [
    setupStep("statement", t(S.statementTitle), t(S.statementDescription), hasData, [
      { kind: "cli", label: copy, target: `${cli} import-csv ${t(S.statementFile)}` },
      { kind: "cli", label: "Open Banking", target: `${cli} eb login "mBank"` },
    ]),
    setupStep(
      "categories",
      t(S.categoriesTitle),
      t(S.categoriesDescription),
      hasData && (facts.manualDecisions > 0 || facts.uncategorized === 0),
      [{ kind: "tab", label: t(S.expensesTab), target: "expenses" }],
    ),
    setupStep(
      "transfers",
      t(S.transfersTitle),
      single ? t(S.transfersSingle) : t(S.transfersDescription),
      hasData && (facts.internalTransfers > 0 || facts.ownMoves > 0 || facts.bankAccounts < 2),
      [{ kind: "cli", label: copy, target: `${cli} match-transfers` }],
    ),
  ];
}
