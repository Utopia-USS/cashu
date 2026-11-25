/**
 * The investments' blank-page steps (`modules/investments/setup.py`): a brokerage account, the
 * strategy, a first contribution or import, a first rules run. The store reads the facts.
 */

import { pick, type SetupContext, type SetupStep, setupStep, setupStrings } from "../core/index.js";
import { investmentsSetupStrings as S } from "./setup.strings.js";

/** What the investments steps read from the vault. */
export interface InvestmentsSetupFacts {
  /** The profile has a brokerage account (removed ones too). */
  readonly hasAccount: boolean;
  /** The profile's strategy document (`strategy.yaml`) exists. */
  readonly hasStrategy: boolean;
  /** Some brokerage account has an investments transaction. */
  readonly hasTransaction: boolean;
  /** Some rules run of the profile finished `ok` or `partial`. */
  readonly hasRun: boolean;
}

/** `setup_status` of the investments module. */
export function investmentsSetupSteps(
  facts: InvestmentsSetupFacts,
  ctx: SetupContext,
): SetupStep[] {
  const { cli, lang } = ctx;
  const t = (text: { readonly pl: string; readonly en: string }) => pick(lang, text);
  const copy = t(setupStrings.copyCommand);
  return [
    setupStep("broker_account", t(S.accountTitle), t(S.accountDescription), facts.hasAccount, [
      {
        kind: "cli",
        label: copy,
        target: `${cli} invest accounts add "XTB IKE" --broker xtb --wrapper ike`,
      },
    ]),
    setupStep("strategy", t(S.strategyTitle), t(S.strategyDescription), facts.hasStrategy, [
      { kind: "cli", label: t(S.strategyTemplate), target: `${cli} invest strategy init` },
    ]),
    setupStep("first_import", t(S.importTitle), t(S.importDescription), facts.hasTransaction, [
      { kind: "cli", label: copy, target: `${cli} ${t(S.importArgs)}` },
    ]),
    setupStep("first_run", t(S.runTitle), t(S.runDescription), facts.hasRun, [
      { kind: "cli", label: copy, target: `${cli} invest run` },
    ]),
  ];
}
