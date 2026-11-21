// The store's `groupSeries` (binary search over candidates and loose charges) gives exactly the
// domain's `budget.groupSeries` (every charge against every candidate): the same charges, in the same
// order, for each candidate, on random groups with overlapping bands, equal and tied typical amounts,
// amounts of every scale, monthly and other cadences and price rises off every band. Synthetic data.
import { addDays, budget, D, type IsoDate } from "@cashu/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { groupSeries } from "./recurring-groups.js";

const START = "2025-01-01";
const day = fc.integer({ min: 0, max: 500 }).map((n) => addDays(START, n));
/** Typical amounts from a small set (overlapping 20% bands, duplicates, ties at equal distance). */
const typical = fc.constantFrom("10.00", "11.00", "12.00", "12", "12.5", "15.00", "18.00", "30.00");
const candidate = fc.record({
  typical,
  gap: fc.constantFrom(1, 2, 3, 4, 7, 14, 28, 30, 31, 45, 60),
  lastDate: day,
});
const amount = fc.oneof(
  // near a typical amount, any scale
  fc
    .tuple(fc.integer({ min: 800, max: 3_700 }), fc.constantFrom(0, 1, 2))
    .map(([n, scale]) => (-(n / 100)).toFixed(scale)),
  // far from every band (loose charges)
  fc.integer({ min: 4_000, max: 9_000 }).map((n) => (-(n / 100)).toFixed(2)),
);
const row = fc.record({ date: day, amount });

interface Row {
  readonly bookingDate: IsoDate;
  readonly amount: ReturnType<typeof D>;
  readonly n: number;
}

function series(
  fn: typeof groupSeries,
  candidates: readonly budget.RecurringCandidate[],
  rows: readonly Row[],
): number[][] {
  return fn(candidates, rows).map((list) => list.map((r) => r.n));
}

describe("property: groupSeries equals the domain's", () => {
  it.each([0, 1, 2, 3])("random groups: seed %i", (i) => {
    fc.assert(
      fc.property(
        fc.array(candidate, { maxLength: 12 }),
        fc.array(row, { maxLength: 120 }),
        (cands, raw) => {
          const candidates: budget.RecurringCandidate[] = cands.map((c) => ({
            counterparty: "SKLEP",
            currency: "PLN",
            typicalAmount: D(c.typical),
            occurrences: 3,
            monthsCovered: 3,
            medianGapDays: c.gap,
            lastDate: c.lastDate,
          }));
          const rows: Row[] = raw.map((r, n) => ({ bookingDate: r.date, amount: D(r.amount), n }));
          expect(series(groupSeries, candidates, rows)).toEqual(
            series(budget.groupSeries, candidates, rows),
          );
        },
      ),
      { numRuns: 300, seed: 52_000 + i },
    );
  });

  it("splits a tie by candidate order and continues a series after a price rise", () => {
    const c = (typicalAmount: string, lastDate: IsoDate): budget.RecurringCandidate => ({
      counterparty: "SKLEP",
      currency: "PLN",
      typicalAmount: D(typicalAmount),
      occurrences: 3,
      monthsCovered: 3,
      medianGapDays: 30,
      lastDate,
    });
    // 11.00 is 1.00 from both 10.00 and 12.00: the earlier candidate (12.00, index 0) takes it.
    const candidates = [c("12.00", "2025-01-10"), c("10.00", "2025-01-10")];
    const rows: Row[] = [
      { bookingDate: "2025-01-10", amount: D("-11.00"), n: 0 },
      // off every band, on 12.00's next date after its last charge (2025-02-10 +- 3 days)
      { bookingDate: "2025-02-12", amount: D("-40.00"), n: 1 },
      { bookingDate: "2025-03-11", amount: D("-41.00"), n: 2 },
    ];
    const expected = [[0, 1, 2], []];
    expect(series(budget.groupSeries, candidates, rows)).toEqual(expected);
    expect(series(groupSeries, candidates, rows)).toEqual(expected);
  });
});
