/**
 * Assets' net-worth contributor (`modules/assets/networth.py`): a vehicle is worth its depreciated
 * value. Python reads the curves through the session; here the caller hands over the profile's
 * stored curves.
 */

import {
  ComputedValuation,
  type NetWorthAccount,
  type NetWorthContributor,
  type Valuation,
} from "../core/index.js";
import { curveValue, type DepreciationTerms } from "./depreciation.js";

/**
 * `AssetsContributor`: every given account with a stored curve (any account type, as in Python) is
 * valued by it. `curves` = the profile's depreciation rows in storage order (one per account).
 */
export function assetsContributor(curves: readonly DepreciationTerms[]): NetWorthContributor {
  return {
    valuations(accounts: ReadonlyMap<string, NetWorthAccount>): ReadonlyMap<string, Valuation> {
      const out = new Map<string, Valuation>();
      for (const dep of curves) {
        if (!accounts.has(dep.accountId)) continue;
        out.set(dep.accountId, new ComputedValuation((d) => curveValue(dep, d)));
      }
      return out;
    },
  };
}
