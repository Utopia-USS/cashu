// Investments blank-page steps (modules/investments/setup.py) over their facts:
// tests/investments/persistence/test_inv_english_texts.py test_setup_steps_in_english, and the
// investments half of tests/test_profiles.py test_setup_status_follows_the_data (an empty module).

import { describe, expect, it } from "vitest";
import { type SetupContext, setupView } from "../core/index.js";
import { type InvestmentsSetupFacts, investmentsSetupSteps } from "./setup.js";

const NONE: InvestmentsSetupFacts = {
  hasAccount: false,
  hasStrategy: false,
  hasTransaction: false,
  hasRun: false,
};
const PL: SetupContext = { cli: "cashu --profile anna", lang: "pl" };
const view = (facts: Partial<InvestmentsSetupFacts>, ctx = PL) =>
  setupView(investmentsSetupSteps({ ...NONE, ...facts }, ctx));

describe("investments setup steps", () => {
  it("an empty module", () => {
    const body = view({});
    expect(body.state).toBe("empty");
    expect(body.steps.map((s) => [s.id, s.status])).toEqual([
      ["broker_account", "on"],
      ["strategy", "todo"],
      ["first_import", "todo"],
      ["first_run", "todo"],
    ]);
  });

  it("each fact closes its step", () => {
    expect(view({ hasAccount: true, hasStrategy: true }).state).toBe("partial");
    expect(
      view({ hasAccount: true, hasStrategy: true, hasTransaction: true, hasRun: true }).state,
    ).toBe("ready");
    expect(view({ hasStrategy: true }).steps.map((s) => s.status)).toEqual([
      "on",
      "done",
      "todo",
      "todo",
    ]);
  });

  it("the commands in Polish", () => {
    expect(view({}).steps.map((s) => s.actions[0]?.target)).toEqual([
      'cashu --profile anna invest accounts add "XTB IKE" --broker xtb --wrapper ike',
      "cashu --profile anna invest strategy init",
      "cashu --profile anna invest import PLIK.csv --account ID_RACHUNKU",
      "cashu --profile anna invest run",
    ]);
    expect(view({}).steps[1]?.actions[0]?.label).toBe("Utwórz z szablonu");
  });

  it("test_setup_steps_in_english", () => {
    const steps = view({}, { cli: "cashu --profile anna", lang: "en" }).steps;
    expect(steps.map((s) => s.title)).toEqual([
      "Add a brokerage account",
      "Save the strategy",
      "First contribution or import",
      "First rules run",
    ]);
    expect(steps[0]?.actions[0]?.label).toBe("Copy command");
    expect(
      steps[2]?.actions[0]?.target.endsWith("invest import FILE.csv --account ACCOUNT_ID"),
    ).toBe(true);
  });
});
