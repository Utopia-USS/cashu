/** Checks of the `budget-categorize-all` scenarios (tests only). */
import type { Mismatches } from "../../../testing/vectors.js";
import { categorizeAll } from "../effective.js";
import {
  categorizeRow,
  inQueryOrder,
  NOT_SUBSCRIPTION,
  type ScenarioContext,
  type ScenarioRow,
  scenarioContext,
} from "./scenarios.js";

type CandidateVector = [string, string, number, number, number, string, string];
export type AllScenario = [
  n: number,
  ctx: ScenarioContext,
  rows: ScenarioRow[],
  order: number[],
  after: [string | null, string | null][],
  recurring: CandidateVector[],
  payees: string[],
];

export interface AllCounts {
  rows: number;
  /** D-09.4: cash-account rows without a claim (TS: no category; Python keeps the stored value). */
  cashUnclaimed: number;
}

/** Compares TS `categorizeAll` with Python's `categorize_all` + `detect_recurring` per scenario. */
export function checkAll(
  scenarios: readonly AllScenario[],
  m: Mismatches,
  counts: AllCounts,
): void {
  for (const [n, c, rows, order, after, recurring, payees] of scenarios) {
    const ctx = scenarioContext(c);
    m.check(`#${n} own ibans`, [...ctx.ownIbans].sort(), c.ownIbans);
    const input = inQueryOrder(rows.map(categorizeRow), order);
    const out = categorizeAll(input, ctx, NOT_SUBSCRIPTION);
    rows.forEach((r, i) => {
      counts.rows++;
      const got = out.results.get(String(r[0]));
      const want = after[i] as [string | null, string | null];
      const claimed = input.find((x) => x.key === String(r[0]))?.claim;
      if (r[2] && !claimed) {
        // FIX(D-09.4): no guessed value on a cash account; Python keeps whatever was stored.
        counts.cashUnclaimed++;
        m.check(`#${n} row ${r[0]} cash unclaimed`, got, null);
        return;
      }
      m.check(`#${n} row ${r[0]}`, got ? [got.category, got.source] : [null, null], want);
    });
    m.check(
      `#${n} recurring`,
      out.recurring.map((x) => [
        x.counterparty,
        x.typicalAmount.toString(),
        x.occurrences,
        x.monthsCovered,
        x.medianGapDays,
        x.lastDate,
        x.currency,
      ]),
      recurring,
    );
    m.check(`#${n} payees`, [...out.subscriptionPayees].sort(cpCompare), payees);
  }
}

/** Python `sorted` of str: code point order. */
function cpCompare(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] as string).codePointAt(0)! - (y[i] as string).codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}
