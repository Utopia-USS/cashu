// The companion's attention list: the prototype's numbers plus the edges. Synthetic data only.

import { describe, expect, it } from "vitest";
import { D } from "../../decimal.js";
import {
  type AttentionBill,
  type AttentionInput,
  type AttentionPayeeChange,
  type AttentionPosition,
  rankAttention,
} from "./attention.js";
import { ATTENTION_THRESHOLDS } from "./thresholds.js";

const base = (over: Partial<AttentionInput> = {}): AttentionInput => ({
  today: "2026-11-12",
  currency: "PLN",
  month: { spentSoFar: D("5960"), usualMonth: D("13100") },
  uncategorized: { count: 4, sum: D("316"), largest: null },
  bills: [],
  positions: [],
  payeeChanges: [],
  freshness: { bankDataAgeHours: 3, consentEndsInDays: null },
  ...over,
});

const bill = (key: string, covered: boolean | null, shortfall: string | null): AttentionBill => ({
  key,
  payee: key,
  when: "2026-11-14",
  amount: D("-100"),
  currency: "PLN",
  account: { id: "a1", name: "Main" },
  covered,
  shortfall: shortfall === null ? null : D(shortfall),
});

const position = (id: string, over: Partial<AttentionPosition> = {}): AttentionPosition => ({
  instrument: { id, name: id },
  weight: 0.05,
  alert: null,
  research: null,
  move: null,
  ...over,
});

const priceUp = (key: string, yearlyEffect: string, currency = "PLN"): AttentionPayeeChange => ({
  kind: "price_up",
  key,
  payee: key,
  currency,
  from: D("49"),
  to: D("60"),
  yearlyEffect: D(yearlyEffect),
  nextDate: "2026-12-03",
});

describe("rankAttention: prototype cases", () => {
  it("owner default: 316 of 5,960 uncategorized is no row", () => {
    const r = rankAttention(base());
    expect(r.rows).toEqual([]);
    expect(r.banner).toBeNull();
  });

  it("big variant: 2,496 of 8,140 is a tier-1 row at 31 %", () => {
    const largest = { payee: "Allegro", date: "2026-11-08", amount: D("-1200") };
    const r = rankAttention(
      base({
        month: { spentSoFar: D("8140"), usualMonth: D("13100") },
        uncategorized: { count: 12, sum: D("2496"), largest },
      }),
    );
    expect(r.rows).toHaveLength(1);
    const row = r.rows[0];
    expect(row?.tier).toBe(1);
    expect(row?.subject).toEqual({ kind: "uncategorized", id: "uncategorized" });
    expect(row?.target).toEqual({ kind: "triage" });
    if (row?.magnitude.kind !== "percent") throw new Error("expected percent");
    expect(Math.round(row.magnitude.value * 100)).toBe(31);
    if (row.reason.kind !== "uncategorized_sum") throw new Error("expected uncategorized_sum");
    expect(row.reason.count).toBe(12);
    expect(row.reason.largest).toBe(largest);
  });

  it("partner electricity +78 a charge is a tier-4 row", () => {
    const r = rankAttention(
      base({
        month: { spentSoFar: D("3410"), usualMonth: D("8900") },
        uncategorized: { count: 0, sum: D("0"), largest: null },
        payeeChanges: [priceUp("PGE", "936")],
      }),
    );
    expect(r.rows.map((x) => [x.tier, x.subject.id])).toEqual([[4, "PGE"]]);
    const m = r.rows[0]?.magnitude;
    expect(m?.kind === "money" && m.signed && m.value.eq(D("936"))).toBe(true);
    expect(r.rows[0]?.target).toEqual({ kind: "none" });
  });

  it("owner Netflix +132 a year is a tier-4 row (131 is 1 % of 13,100)", () => {
    const r = rankAttention(base({ payeeChanges: [priceUp("Netflix", "132")] }));
    expect(r.rows.map((x) => x.reason.kind)).toEqual(["payee_price_up"]);
    expect(rankAttention(base({ payeeChanges: [priceUp("Netflix", "130")] })).rows).toEqual([]);
  });

  it("a position with an action alert at weight 0.074 is tier 2 at 7.4 %", () => {
    const r = rankAttention(
      base({
        positions: [
          position("NVDA", { weight: 0.074, alert: { severity: "action", title: "Stop" } }),
        ],
      }),
    );
    const row = r.rows[0];
    expect(row?.tier).toBe(2);
    expect(row?.magnitude).toEqual({ kind: "percent", value: 0.074 });
    expect(row?.target).toEqual({ kind: "position", instrument: "NVDA" });
    expect(row?.reason).toEqual({
      kind: "position",
      instrument: { id: "NVDA", name: "NVDA" },
      alertFired: true,
      researchVerdict: null,
      dayMove: null,
    });
  });

  it("stale 72 h is the banner, not a row", () => {
    const r = rankAttention(base({ freshness: { bankDataAgeHours: 72, consentEndsInDays: null } }));
    expect(r.rows).toEqual([]);
    expect(r.banner).toEqual({ kind: "stale", ageHours: 72 });
  });

  it("5 candidates -> 3 rows, by tier then size", () => {
    const r = rankAttention(
      base({
        month: { spentSoFar: D("8140"), usualMonth: D("13100") },
        uncategorized: { count: 12, sum: D("2496"), largest: null },
        bills: [bill("Rata", false, "420")],
        positions: [
          position("NVDA", { weight: 0.074, alert: { severity: "action", title: null } }),
        ],
        payeeChanges: [priceUp("Netflix", "132"), priceUp("PGE", "936")],
      }),
    );
    expect(r.rows.map((x) => [x.tier, x.subject.kind, x.subject.id])).toEqual([
      [1, "bill", "Rata"],
      [1, "uncategorized", "uncategorized"],
      [2, "position", "NVDA"],
    ]);
  });
});

describe("rankAttention: rules", () => {
  it("uncategorized needs both the share of spent and the floor of a usual month", () => {
    // 20 % of a small month, but below 5 % of the usual month
    const small = base({
      month: { spentSoFar: D("1000"), usualMonth: D("13100") },
      uncategorized: { count: 1, sum: D("200"), largest: null },
    });
    expect(rankAttention(small).rows).toEqual([]);
    // no usual month: never
    expect(
      rankAttention(
        base({
          month: { spentSoFar: D("8140"), usualMonth: null },
          uncategorized: { count: 12, sum: D("2496"), largest: null },
        }),
      ).rows,
    ).toEqual([]);
    // nothing spent: never
    expect(
      rankAttention(
        base({
          month: { spentSoFar: D("0"), usualMonth: D("100") },
          uncategorized: { count: 1, sum: D("50"), largest: null },
        }),
      ).rows,
    ).toEqual([]);
    // exactly at both edges: a row
    const edge = base({
      month: { spentSoFar: D("10000"), usualMonth: D("20000") },
      uncategorized: { count: 1, sum: D("1000"), largest: null },
    });
    expect(rankAttention(edge).rows).toHaveLength(1);
  });

  it("bills: one row per uncovered bill, by shortfall; covered and unknown are not rows", () => {
    const r = rankAttention(
      base({
        bills: [
          bill("ok", true, null),
          bill("unknown", null, null),
          bill("small", false, "10"),
          bill("big", false, "300"),
        ],
      }),
    );
    expect(r.rows.map((x) => x.subject.id)).toEqual(["big", "small"]);
    expect(r.rows[0]?.target).toEqual({ kind: "bill", key: "big" });
    // a shortfall in another currency is neither labelled with the list's currency nor compared
    const mixed = rankAttention(
      base({
        bills: [bill("pln", false, "10"), { ...bill("eur", false, "300"), currency: "EUR" }],
      }),
    );
    expect(mixed.rows.map((x) => x.subject.id)).toEqual(["pln"]);
    expect(r.rows[0]?.magnitude.kind === "money" && !r.rows[0].magnitude.signed).toBe(true);
  });

  it("positions: weight gate for research and moves, not for an action alert", () => {
    const rows = (p: AttentionPosition) => rankAttention(base({ positions: [p] })).rows;
    expect(rows(position("a", { research: { verdict: "weakens" } }))).toHaveLength(1);
    expect(rows(position("a", { research: { verdict: "invalidates" } }))).toHaveLength(1);
    expect(rows(position("a", { research: { verdict: "supports" } }))).toHaveLength(0);
    expect(rows(position("a", { move: { day: -0.05, weekSigma: null } }))).toHaveLength(1);
    expect(rows(position("a", { move: { day: 0.049, weekSigma: null } }))).toHaveLength(0);
    expect(rows(position("a", { move: { day: null, weekSigma: 2 } }))).toHaveLength(1);
    expect(rows(position("a", { move: { day: null, weekSigma: 1.9 } }))).toHaveLength(0);
    // a week's move counts either way, as the day's
    expect(rows(position("a", { move: { day: null, weekSigma: -2 } }))).toHaveLength(1);
    expect(rows(position("a", { move: { day: null, weekSigma: -1.9 } }))).toHaveLength(0);
    expect(rows(position("a", { alert: { severity: "info", title: null } }))).toHaveLength(0);
    // below 3 %: only an action alert counts
    const light = { weight: 0.02 };
    expect(rows(position("a", { ...light, research: { verdict: "invalidates" } }))).toHaveLength(0);
    expect(rows(position("a", { ...light, move: { day: 0.2, weekSigma: 5 } }))).toHaveLength(0);
    expect(
      rows(position("a", { ...light, alert: { severity: "action", title: null } })),
    ).toHaveLength(1);
    const one = rows(
      position("a", { research: { verdict: "weakens" }, move: { day: -0.07, weekSigma: 3 } }),
    )[0];
    expect(one?.reason).toMatchObject({
      alertFired: false,
      researchVerdict: "weakens",
      dayMove: -0.07,
    });
  });

  it("payee changes: new recurring always, price rises over 1 % of a usual month, own currency only", () => {
    const fresh: AttentionPayeeChange = {
      kind: "new_recurring",
      key: "Disney",
      payee: "Disney",
      currency: "PLN",
      amount: D("37.99"),
      cadenceDays: 30,
    };
    const r = rankAttention(
      base({ payeeChanges: [fresh, priceUp("Netflix", "132"), priceUp("Spotify", "500", "EUR")] }),
    );
    expect(r.rows.map((x) => x.subject.id)).toEqual(["Netflix", "Disney"]);
    expect(r.rows[1]?.magnitude).toEqual({
      kind: "money",
      value: D("37.99"),
      currency: "PLN",
      signed: false,
    });
    // without a usual month a price rise cannot be weighed
    expect(
      rankAttention(
        base({
          month: { spentSoFar: D("100"), usualMonth: null },
          payeeChanges: [priceUp("Netflix", "132")],
        }),
      ).rows,
    ).toEqual([]);
  });

  it("banner: stale first, else a consent ending within 7 days", () => {
    const fresh = (bankDataAgeHours: number | null, days: number | null) =>
      rankAttention(
        base({
          freshness: {
            bankDataAgeHours,
            consentEndsInDays: days === null ? null : { bank: "mBank", days },
          },
        }),
      ).banner;
    expect(fresh(36, 2)).toEqual({ kind: "stale", ageHours: 36 });
    expect(fresh(35, 7)).toEqual({ kind: "consent_ending", bank: "mBank", daysLeft: 7 });
    expect(fresh(null, 8)).toBeNull();
    expect(fresh(null, null)).toBeNull();
  });

  it("thresholds are the agreed numbers", () => {
    expect(ATTENTION_THRESHOLDS).toEqual({
      uncategorizedShareOfSpent: 0.1,
      uncategorizedFloorOfUsual: 0.05,
      positionWeight: 0.03,
      positionDayMove: 0.05,
      positionWeekSigma: 2,
      staleAfterHours: 36,
      consentWarnDays: 7,
      payeeChangeYearlyOfUsual: 0.01,
      maxRows: 3,
    });
  });

  it("empty input", () => {
    const r = rankAttention(
      base({
        month: { spentSoFar: D("0"), usualMonth: null },
        uncategorized: { count: 0, sum: D("0"), largest: null },
        freshness: { bankDataAgeHours: null, consentEndsInDays: null },
      }),
    );
    expect(r).toEqual({ rows: [], banner: null });
  });
});
