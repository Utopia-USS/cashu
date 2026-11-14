// Investments blank-page steps over their facts, and the CLI commands they offer.

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

  it("each step offers the CLI command that does it", () => {
    expect(view({}).steps.map((s) => s.actions[0]?.target)).toEqual([
      'cashu --profile anna invest accounts add "XTB IKE" --broker xtb --wrapper ike',
      "cashu --profile anna invest strategy init",
      "cashu --profile anna invest import PLIK.csv --account ID_RACHUNKU",
      "cashu --profile anna invest run",
    ]);
  });
});
