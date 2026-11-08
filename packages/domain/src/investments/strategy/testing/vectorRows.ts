// Replays rows of the retired Python vectors_inv_strategy.py against the TS loader. Test-only.

import { Mismatches } from "../../../testing/vectors.js";
import { classify } from "../codes.js";
import { loadStrategy } from "../loader.js";
import { type Json, resultOut, sortKeys } from "./canonical.js";

/** Checks `rows`; a `raises` row (Python crashed outside the loader's contract) must load in TS. */
export function replay(rows: readonly unknown[][], first: number): Mismatches {
  const m = new Mismatches();
  for (const [i, row] of rows.entries()) {
    const [kind, yaml, md, expected] = row as [string, string, string | null, Json];
    const label = `#${first + i} ${JSON.stringify(yaml.slice(0, 80))}`;
    if (kind === "classify") {
      m.check(label, sortKeys(classify(yaml) as unknown as Json), expected);
      continue;
    }
    const result = loadStrategy(yaml, md);
    if (kind === "raises") m.check(`${label} (Python raised ${String(expected)})`, true, true);
    else m.check(label, sortKeys(resultOut(result)), expected);
  }
  return m;
}
