// Budget blank-page steps (modules/budget/setup.py) over their facts, test-for-test with the step halves
// of tests/test_first_steps_api.py test_budget_steps and
// test_budget_transfers_step_counts_own_moves_without_an_iban_pair, tests/test_profiles.py
// test_setup_endpoint_shape and tests/test_i18n_core_modules.py test_modules_and_setup_steps_in_english
// (budget). The counts behind the facts are the store's (packages/store setup queries, their tests).

import { describe, expect, it } from "vitest";
import { type SetupContext, setupView } from "../core/index.js";
import { type BudgetSetupFacts, budgetSetupSteps } from "./setup.js";

const NONE: BudgetSetupFacts = {
  bankAccounts: 0,
  transactions: 0,
  uncategorized: 0,
  manualDecisions: 0,
  internalTransfers: 0,
  ownMoves: 0,
};
const PL: SetupContext = { cli: "cashu --profile jan", lang: "pl" };
const view = (facts: Partial<BudgetSetupFacts>, ctx = PL) =>
  setupView(budgetSetupSteps({ ...NONE, ...facts }, ctx));

describe("budget setup steps", () => {
  it("test_budget_steps: a new profile", () => {
    const body = view({});
    expect(body.state).toBe("empty");
    expect(body.steps.map((s) => [s.id, s.title, s.status])).toEqual([
      ["statement", "Pierwszy wyciąg z banku", "on"],
      ["categories", "Kategorie wydatków", "todo"],
      ["transfers", "Przelewy między kontami", "todo"],
    ]);
    const statement = body.steps[0];
    expect(statement?.description).toBe("Plik CSV (mBank, Pekao, Erste) albo Open Banking.");
    expect(statement?.actions.map((a) => a.target)).toEqual([
      "cashu --profile jan import-csv WYCIAG.csv",
      'cashu --profile jan eb login "mBank"',
    ]);
    expect(body.steps[2]?.description).toBe(
      "Po IBAN między Twoimi kontami; nie liczą się jako wydatki.",
    );
  });

  it("test_budget_steps: one statement of one bank account, one unknown merchant", () => {
    const body = view({ bankAccounts: 1, transactions: 1, uncategorized: 1 });
    expect(body.state).toBe("partial");
    const byId = new Map(body.steps.map((s) => [s.id, s]));
    expect(byId.get("statement")?.status).toBe("done");
    expect(byId.get("categories")?.status).toBe("on");
    expect(byId.get("transfers")?.status).toBe("done"); // one bank account: nothing to pair
    expect(byId.get("transfers")?.description).toBe("Jedno konto bankowe: nic do dopasowania.");
  });

  it("categories are done by a manual decision or when nothing is left uncategorized", () => {
    const status = (f: Partial<BudgetSetupFacts>) =>
      view({ bankAccounts: 1, transactions: 3, ...f }).steps[1]?.status;
    expect(status({ uncategorized: 2 })).toBe("on");
    expect(status({ uncategorized: 2, manualDecisions: 1 })).toBe("done");
    expect(status({ uncategorized: 0 })).toBe("done");
    expect(view({ manualDecisions: 4 }).steps[1]?.status).toBe("todo"); // no data yet
  });

  it("test_budget_transfers_step_counts_own_moves_without_an_iban_pair", () => {
    const two = { bankAccounts: 2, transactions: 2 };
    expect(view(two).steps[2]?.status).not.toBe("done");
    expect(view(two).steps[2]?.description).toBe(
      "Po IBAN między Twoimi kontami; nie liczą się jako wydatki.",
    );
    expect(view({ ...two, ownMoves: 1 }).steps[2]?.status).toBe("done");
    expect(view({ ...two, internalTransfers: 2 }).steps[2]?.status).toBe("done");
    expect(view({ ...two, internalTransfers: 2 }).state).toBe("ready");
  });

  it("test_setup_endpoint_shape (budget)", () => {
    const body = view({});
    for (const step of body.steps) {
      expect(Object.keys(step).sort()).toEqual(
        ["actions", "description", "id", "optional", "status", "title"].sort(),
      );
      expect(step.optional).toBe(false);
      for (const a of step.actions) {
        expect(["cli", "tab"]).toContain(a.kind);
        if (a.kind === "cli") expect(a.target.startsWith("cashu --profile jan ")).toBe(true);
      }
    }
    expect(body.steps[1]?.actions).toEqual([{ kind: "tab", label: "Wydatki", target: "expenses" }]);
  });

  it("test_modules_and_setup_steps_in_english (budget)", () => {
    const steps = view({}, { cli: "cashu --profile jan", lang: "en" }).steps;
    expect(steps[0]?.title).toBe("First bank statement");
    expect(steps[0]?.actions[0]?.label).toBe("Copy command");
    expect(steps[0]?.actions[0]?.target.endsWith("import-csv STATEMENT.csv")).toBe(true);
    expect(steps[1]?.actions[0]?.label).toBe("Expenses");
    const texts = steps.flatMap((s) => [s.title, s.description]);
    expect(texts.some((t) => /[ąęółśżźćń—]/.test(t))).toBe(false);
  });
});
