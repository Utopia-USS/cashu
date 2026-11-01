/**
 * Producers of `investments.valuation` and `investments.allocation`
 * (`parity/python/checks/investments.py`): per profile with the investments module, the portfolio
 * state as of `as_of` (`portfolioState.ts`) written like canon.py writes the Python dataclasses.
 */

import type { PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";
import { buildPortfolioState, type PortfolioState } from "./portfolioState.ts";
import { Serializer } from "./serialize.ts";
import type { StrategyInputsByProfile } from "./strategy.ts";

const MODULE = "investments";

/** The state of every profile with the investments module, keyed by the profile's natural key. */
function states(db: PythonDb, strategies: StrategyInputsByProfile): Map<string, PortfolioState> {
  const out = new Map<string, PortfolioState>();
  for (const p of db.profiles()) {
    if (!db.enabledModules(p.id).includes(MODULE)) continue;
    const key = db.keys.key("profiles", p.id);
    const inputs = strategies.get(key);
    if (inputs === undefined) throw new Error("no strategy inputs for a profile");
    out.set(key, buildPortfolioState(db, p, inputs));
  }
  return out;
}

export function produceValuation(db: PythonDb, strategies: StrategyInputsByProfile): OutValue {
  const s = new Serializer(db);
  const out: Record<string, OutValue> = {};
  for (const [key, state] of states(db, strategies)) {
    out[key] = {
      as_of: state.asOf,
      base: state.base,
      snapshot: s.snapshot(state.snapshot),
      valued: s.valued(state.valued),
    };
  }
  return out;
}

export function produceAllocation(db: PythonDb, strategies: StrategyInputsByProfile): OutValue {
  const s = new Serializer(db);
  const out: Record<string, OutValue> = {};
  for (const [key, state] of states(db, strategies)) {
    out[key] = { allocation: state.allocation === null ? null : s.allocation(state.allocation) };
  }
  return out;
}
