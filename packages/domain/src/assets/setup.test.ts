// Assets blank-page steps (modules/assets/setup.py) over their facts: the step halves of
// tests/test_first_steps_api.py test_assets_vehicle_step_is_optional and
// tests/test_i18n_core_modules.py test_modules_and_setup_steps_in_english (assets).

import { describe, expect, it } from "vitest";
import { type SetupContext, setupView } from "../core/index.js";
import { type AssetsSetupFacts, assetsSetupSteps } from "./setup.js";

const NONE: AssetsSetupFacts = { positions: 0, vehicles: 0, depreciatingVehicles: 0 };
const PL: SetupContext = { cli: "cashu --profile jan", lang: "pl" };
const view = (facts: Partial<AssetsSetupFacts>, ctx = PL) =>
  setupView(assetsSetupSteps({ ...NONE, ...facts }, ctx));

describe("assets setup steps", () => {
  it("test_assets_vehicle_step_is_optional", () => {
    const body = view({});
    expect(body.steps.map((s) => [s.id, s.title, s.optional, s.status])).toEqual([
      ["position", "Pozycja", false, "on"],
      ["vehicle", "Auto", true, "todo"],
    ]);
    expect(body.steps[1]?.description).toBe(
      "Cena i data zakupu, roczny spadek; wartość liczy się sama.",
    );
    const house = view({ positions: 1 });
    expect(house.state).toBe("ready");
    expect(house.steps.map((s) => s.status)).toEqual(["done", "todo"]);
    const car = view({ positions: 2, vehicles: 1, depreciatingVehicles: 1 });
    expect(car.steps.map((s) => s.status)).toEqual(["done", "done"]);
  });

  it("a car without its curve leaves the optional step open", () => {
    expect(view({ positions: 2, vehicles: 2, depreciatingVehicles: 1 }).steps[1]?.status).toBe(
      "todo",
    );
  });

  it("the commands", () => {
    const steps = view({}).steps;
    expect(steps.map((s) => s.actions[0]?.target)).toEqual([
      'cashu --profile jan add-position "Mieszkanie" --type property --value 500000',
      'cashu --profile jan set-vehicle "Auto" 80000 2025-05-01 --rate 15',
    ]);
  });

  it("test_modules_and_setup_steps_in_english (assets)", () => {
    const steps = view({}, { cli: "cashu --profile jan", lang: "en" }).steps;
    expect(steps.map((s) => s.title)).toEqual(["Position", "Car"]);
    expect(steps[0]?.actions[0]?.target).toContain('"Flat"');
    const texts = steps.flatMap((s) => [s.title, s.description]);
    expect(texts.some((t) => /[ąęółśżźćń—]/.test(t))).toBe(false);
  });
});
