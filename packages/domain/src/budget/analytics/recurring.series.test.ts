// `groupSeries` against the code before the band was hoisted out of its inner loop (`frozenGroupSeries`
// below, verbatim from that commit): the same members for random candidates and charges built around
// the band edges (exactly typical x (1 + tolerance), typical / (1 + tolerance), one minor unit either
// side), with zero, positive and negative amounts, large values, mixed exponents (`100` / `100.00`),
// tolerances 0 to 1 and a low-precision decimal context. Synthetic data only.
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, type IsoDate } from "../../dates.js";
import {
  D,
  type Decimal,
  type DecimalContext,
  localContext,
  makeContext,
  ONE,
} from "../../decimal.js";
import type { RecurringCandidate } from "../categorize/index.js";
import { groupSeries, SERIES_DATE_SLACK_DAYS } from "./recurring.js";
import { nextChargeDate } from "./upcoming.js";

// ---- frozen: the pre-hoist code (one `inBand` per row x candidate pair) ----
function frozenInBand(amount: Decimal, typical: Decimal, tolerance: Decimal): boolean {
  const factor = ONE.add(tolerance);
  return amount.mul(factor).gte(typical) && amount.lte(typical.mul(factor));
}

function frozenGroupSeries<T extends { readonly bookingDate: IsoDate; readonly amount: Decimal }>(
  own: readonly RecurringCandidate[],
  rows: readonly T[],
  tolerance: Decimal,
): T[][] {
  const members = own.map((): T[] => []);
  const byDate = [...rows].sort((a, b) =>
    a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : 0,
  );
  const loose: T[] = [];
  for (const t of byDate) {
    const amount = t.amount.copyAbs();
    let best = -1;
    for (const [i, c] of own.entries()) {
      if (!frozenInBand(amount, c.typicalAmount, tolerance)) continue;
      if (
        best === -1 ||
        amount
          .sub(c.typicalAmount)
          .copyAbs()
          .lt(amount.sub((own[best] as RecurringCandidate).typicalAmount).copyAbs())
      )
        best = i;
    }
    if (best === -1) loose.push(t);
    else members[best]?.push(t);
  }
  for (const [ci, c] of own.entries()) {
    const series = members[ci] as T[];
    let last = series.at(-1)?.bookingDate ?? c.lastDate;
    for (let i = 0; i < loose.length; i++) {
      const t = loose[i] as T;
      if (t.bookingDate <= last) continue;
      const off = Math.abs(daysBetween(nextChargeDate(last, c.medianGapDays), t.bookingDate));
      if (off > SERIES_DATE_SLACK_DAYS) continue;
      series.push(t);
      last = t.bookingDate;
      loose.splice(i, 1);
      i--;
    }
  }
  return members;
}
// ---- end frozen ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Row {
  readonly id: number;
  readonly bookingDate: IsoDate;
  readonly amount: Decimal;
}

const TYPICALS = [
  "100.00",
  "100",
  "116.00",
  "29.99",
  "0.01",
  "0",
  "1E+20",
  "123456789012.34",
  "7.5",
];
const TOLERANCES = ["0.15", "0", "0.1", "1", "0.333", "0.15000"];
const GAPS = [7, 14, 30, 31, 61, 91];
const START: IsoDate = "2025-01-03";

/** An amount on or around a band edge of `typical` (or plain noise), signed either way. */
function edgeAmount(rand: () => number, typical: Decimal, tolerance: Decimal): Decimal {
  const factor = ONE.add(tolerance);
  const unit = D("0.01");
  const pick = Math.floor(rand() * 10);
  let a: Decimal;
  if (pick === 0) a = typical;
  else if (pick === 1)
    a = typical.mul(factor); // upper edge, exact
  else if (pick === 2) a = typical.mul(factor).add(unit);
  else if (pick === 3) a = typical.mul(factor).sub(unit);
  else if (pick === 4 && !factor.isZero())
    a = typical.div(factor); // lower edge (rounded)
  else if (pick === 5 && !factor.isZero()) a = typical.div(factor).quantize(unit);
  else if (pick === 6 && !factor.isZero()) a = typical.div(factor).quantize(unit).sub(unit);
  else if (pick === 7) a = D("0");
  else if (pick === 8) a = D(TYPICALS[Math.floor(rand() * TYPICALS.length)] as string);
  else a = D((rand() * 300).toFixed(2));
  return rand() < 0.7 ? a.copyNegate() : a;
}

function scenario(rand: () => number) {
  const tolerance = D(TOLERANCES[Math.floor(rand() * TOLERANCES.length)] as string);
  const nCand = Math.floor(rand() * 5); // 0..4 candidates (0: every row is loose)
  const own: RecurringCandidate[] = [];
  for (let i = 0; i < nCand; i++) {
    own.push({
      counterparty: "ACME CLOUD",
      currency: "PLN",
      typicalAmount: D(TYPICALS[Math.floor(rand() * TYPICALS.length)] as string),
      occurrences: 3,
      monthsCovered: 3,
      medianGapDays: GAPS[Math.floor(rand() * GAPS.length)] as number,
      lastDate: addDays(START, Math.floor(rand() * 200)),
    });
  }
  const rows: Row[] = [];
  const nRows = Math.floor(rand() * 30);
  for (let i = 0; i < nRows; i++) {
    const base =
      own.length > 0 && rand() < 0.8
        ? (own[Math.floor(rand() * own.length)] as RecurringCandidate).typicalAmount
        : D((rand() * 200).toFixed(2));
    rows.push({
      id: i,
      bookingDate: addDays(START, Math.floor(rand() * 400)),
      amount: edgeAmount(rand, base, tolerance),
    });
  }
  return { own, rows, tolerance };
}

const ids = (groups: Row[][]): number[][] => groups.map((g) => g.map((r) => r.id));

const CONTEXTS: readonly (DecimalContext | null)[] = [
  null,
  makeContext({ prec: 6 }),
  makeContext({ prec: 3, rounding: "ROUND_DOWN" }),
];

describe("groupSeries equals the pre-hoist code", () => {
  it("on random candidates and charges around the band edges", () => {
    const runs = 3_000;
    const rand = mulberry32(52_004);
    let members = 0;
    let loose = 0;
    for (let run = 0; run < runs; run++) {
      const { own, rows, tolerance } = scenario(rand);
      const ctx = CONTEXTS[run % CONTEXTS.length] ?? null;
      const go = <R>(fn: () => R): R => (ctx === null ? fn() : localContext(ctx, fn));
      const want = go(() => frozenGroupSeries(own, rows, tolerance));
      const got = go(() => groupSeries(own, rows, tolerance));
      expect(ids(got)).toEqual(ids(want));
      for (const [i, g] of got.entries()) {
        // the very same row objects, not equal copies
        for (const [j, r] of g.entries()) expect(r).toBe(want[i]?.[j]);
      }
      const placed = want.reduce((n, g) => n + g.length, 0);
      members += placed;
      loose += rows.length - placed;
    }
    // the generator reaches both outcomes, not only one of them
    expect(members).toBeGreaterThan(runs);
    expect(loose).toBeGreaterThan(runs);
  });

  it("on the band boundaries themselves (inclusive both ways, ties to the earlier candidate)", () => {
    const at = (lastDate: IsoDate, typical: string): RecurringCandidate => ({
      counterparty: "ACME CLOUD",
      currency: "PLN",
      typicalAmount: D(typical),
      occurrences: 3,
      monthsCovered: 3,
      medianGapDays: 30,
      lastDate,
    });
    const own = [at("2025-01-01", "100.00"), at("2025-01-01", "130.00"), at("2025-01-01", "100")];
    const amounts = [
      "-115.00",
      "-115.01",
      "-86.96",
      "-86.95",
      "-0",
      "0",
      "-115",
      "-1E+30",
      "-130.00",
    ];
    const rows: Row[] = amounts.map((a, i) => ({
      id: i,
      bookingDate: addDays("2025-01-01", 400 + i),
      amount: D(a),
    }));
    for (const tol of TOLERANCES) {
      const tolerance = D(tol);
      expect(ids(groupSeries(own, rows, tolerance))).toEqual(
        ids(frozenGroupSeries(own, rows, tolerance)),
      );
    }
    // the 15% band spelled out: 115.00 fits 100 (100 x 1.15, inclusive) and 130 at the same distance
    // (the earlier candidate wins the tie), 115.01 only 130; 86.96 fits 100 (x 1.15 = 100.004), 86.95
    // nothing (99.9925); zero, -0 and 1E+30 nothing
    expect(ids(groupSeries(own, rows, D("0.15")))).toEqual([[0, 2, 6], [1, 8], []]);
  });
});
