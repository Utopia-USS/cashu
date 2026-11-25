/**
 * The assets' blank-page steps (`modules/assets/setup.py`): a manually valued position and, optionally,
 * a car with a depreciation curve. The store reads the facts.
 */

import { pick, type SetupContext, type SetupStep, setupStep, setupStrings } from "../core/index.js";
import { assetsSetupStrings as S } from "./setup.strings.js";

/** Account types that count as a position on the assets' blank page. */
export const SETUP_POSITION_TYPES: readonly string[] = [
  "property",
  "vehicle",
  "investment",
  "other",
];

/** What the assets steps read from the vault (removed positions never count, F7 MB2). */
export interface AssetsSetupFacts {
  /** Non-removed accounts of a position type. */
  readonly positions: number;
  /** Of those, vehicles. */
  readonly vehicles: number;
  /** Depreciation curves of those vehicles. */
  readonly depreciatingVehicles: number;
}

/** `setup_status` of the assets module. */
export function assetsSetupSteps(facts: AssetsSetupFacts, ctx: SetupContext): SetupStep[] {
  const { cli, lang } = ctx;
  const t = (text: { readonly pl: string; readonly en: string }) => pick(lang, text);
  const copy = t(setupStrings.copyCommand);
  const car = t(S.car);
  return [
    setupStep("position", t(S.positionTitle), t(S.positionDescription), facts.positions > 0, [
      {
        kind: "cli",
        label: copy,
        target: `${cli} add-position "${t(S.flat)}" --type property --value 500000`,
      },
    ]),
    // Optional (first steps A3 / D8): never counts toward the state; done only when a car with a
    // depreciation curve exists (a profile without a car is not "done", it simply skips it).
    setupStep(
      "vehicle",
      car,
      t(S.vehicleDescription),
      facts.vehicles > 0 && facts.depreciatingVehicles === facts.vehicles,
      [
        {
          kind: "cli",
          label: copy,
          target: `${cli} set-vehicle "${car}" 80000 2025-05-01 --rate 15`,
        },
      ],
      true,
    ),
  ];
}
