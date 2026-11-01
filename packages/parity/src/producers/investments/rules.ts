// Actual native evaluation over the copied dataset, without Python outcome inputs.
import { investments as inv } from "@cashu/domain";
import { buildRuleContext, RulesEngine } from "@cashu/domain/investments/rules";
import { usableConfig } from "@cashu/domain/investments/strategy";
import type { PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";
import { buildPortfolioState } from "./portfolioState.ts";
import { sid } from "./rows.ts";
import { ruleIdentifier, ruleOutcome } from "./rulesOut.ts";
import { profileStrategy, type StrategyInputsByProfile } from "./strategy.ts";

export function produceRules(db: PythonDb, strategies: StrategyInputsByProfile): OutValue {
  const out: Record<string, OutValue> = {};
  for (const profile of db.profiles()) {
    if (!db.enabledModules(profile.id).includes("investments")) continue;
    const key = db.keys.key("profiles", profile.id);
    const status = profileStrategy(db, profile);
    const config = usableConfig(status);
    if (config === null) {
      out[key] = { strategy_state: status.state, outcomes: null };
      continue;
    }
    const inputs = strategies.get(key);
    if (inputs === undefined) throw new Error("missing native strategy inputs");
    const state = buildPortfolioState(db, profile, inputs);
    const ctx = buildRuleContext({
      profileId: inv.asProfileId(sid(profile.id)),
      asOf: db.asOf,
      portfolio: state.valued,
      market: state.market,
      allocation: state.allocation,
      data: config.data,
      contributions: config.contributions,
      lang: "pl",
    });
    out[key] = {
      strategy_state: status.state,
      rules: config.rules.map((rule) => ({ id: ruleIdentifier(rule.id, db), kind: rule.kind })),
      outcomes: new RulesEngine(config.rules)
        .evaluate(ctx)
        .map((outcome) => ruleOutcome(outcome, db)),
    };
  }
  return out;
}
