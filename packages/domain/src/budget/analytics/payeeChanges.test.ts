// Payee changes of the companion: price rises with their yearly effect and new recurring payees.
// Synthetic data only.

import { describe, expect, it } from "vitest";
import type { AttentionPayeeChange } from "../../core/attention/index.js";
import { addDays } from "../../dates.js";
import { D, type Decimal } from "../../decimal.js";
import {
  NEW_RECURRING_MIN_OCCURRENCES,
  NEW_RECURRING_WINDOW_DAYS,
  type PayeeChargeHistory,
  PRICE_UP_MIN_SHARE,
  payeeChanges,
} from "./payeeChanges.js";

const eq = (a: Decimal | null | undefined, b: string) => expect(a?.eq(D(b))).toBe(true);
const TODAY = "2026-11-12";

/** Charges newest first: `amounts[0]` on `lastDate`, each older one `gap` days before. */
const payee = (
  key: string,
  amounts: readonly string[],
  over: Partial<PayeeChargeHistory> = {},
): PayeeChargeHistory => {
  const gap = over.medianGapDays ?? 30;
  const lastDate = over.lastDate ?? "2026-11-03";
  const charges = amounts.map((a, i) => ({ date: addDays(lastDate, -gap * i), amount: D(a) }));
  return {
    key,
    payee: key,
    typicalAmount: D(amounts[0] ?? "0"),
    currency: "PLN",
    lastDate,
    medianGapDays: gap,
    account: null,
    charges,
    // long-known payees by default (not new)
    firstSeen: "2025-01-03",
    ...over,
  };
};

const changes = (payees: PayeeChargeHistory[], currency = "PLN") =>
  payeeChanges({ today: TODAY, currency, payees });

describe("payeeChanges: price_up", () => {
  it("constants", () => {
    expect(PRICE_UP_MIN_SHARE).toBe(0.1);
    expect(NEW_RECURRING_MIN_OCCURRENCES).toBe(3);
    expect(NEW_RECURRING_WINDOW_DAYS).toBe(90);
  });

  it("owner Netflix 49 -> 60 monthly: 11 a charge, 132 a year", () => {
    const [c, ...rest] = changes([payee("Netflix", ["60", "49", "49", "49", "49"])]);
    expect(rest).toHaveLength(0);
    if (c?.kind !== "price_up") throw new Error("expected price_up");
    eq(c.from, "49");
    eq(c.to, "60");
    eq(c.perCharge, "11");
    eq(c.yearlyEffect, "132");
    expect(c.cadenceDays).toBe(30);
    expect(c.since).toBe("2026-11-03");
    expect(c.nextDate).toBe("2026-12-03");
    // 31-day median gap is monthly too
    const c31 = changes([payee("Netflix", ["60", "49", "49"], { medianGapDays: 31 })])[0];
    expect(c31?.kind === "price_up" && c31.yearlyEffect.eq(D("132"))).toBe(true);
  });

  it("partner PGE 208 -> 286, cadence 30: 78 a charge", () => {
    const [c] = changes([payee("PGE", ["286", "208", "208", "208"])]);
    if (c?.kind !== "price_up") throw new Error("expected price_up");
    eq(c.perCharge, "78");
    eq(c.yearlyEffect, "936");
  });

  it("a small rise is returned with its yearly effect: whether it is worth a look is attention's call", () => {
    // 5 a charge, 60 a year: the attention list drops it against a usual month of 13,100 (1 % = 131)
    const [c] = changes([payee("Netflix", ["54", "49", "49", "49"])]);
    expect(c?.kind === "price_up" && c.yearlyEffect.eq(D("60"))).toBe(true);
  });

  it("below 10 % does not qualify, whatever the yearly effect", () => {
    expect(changes([payee("Czynsz", ["1090", "1000", "1000"])])).toHaveLength(0);
    expect(changes([payee("Czynsz", ["1100", "1000", "1000"])])).toHaveLength(1);
  });

  it("from = the median of the older charges; at least 2 older charges", () => {
    const [c] = changes([payee("Gym", ["100", "50", "40"])]);
    if (c?.kind !== "price_up") throw new Error("expected price_up");
    eq(c.from, "45");
    expect(changes([payee("Gym", ["100", "50"])])).toHaveLength(0);
    const [odd] = changes([payee("Gym", ["100", "80", "50", "40"])]);
    expect(odd?.kind === "price_up" && odd.from.eq(D("50"))).toBe(true);
  });

  it("a non-monthly cadence counts 365 / gap charges a year", () => {
    const [c] = changes([payee("Weekly", ["14", "7", "7"], { medianGapDays: 7 })]);
    if (c?.kind !== "price_up") throw new Error("expected price_up");
    eq(c.yearlyEffect, "365");
    expect(c.nextDate).toBe("2026-11-10");
  });

  it("other currencies are left out", () => {
    expect(changes([payee("Spotify", ["20", "9.99", "9.99"], { currency: "EUR" })])).toHaveLength(
      0,
    );
    expect(
      changes([payee("Spotify", ["20", "9.99", "9.99"], { currency: "EUR" })], "EUR"),
    ).toHaveLength(1);
  });
});

describe("payeeChanges: new_recurring", () => {
  it("3 charges, the first within 90 days", () => {
    const [c] = changes([
      payee("Disney", ["37.99", "37.99", "37.99"], { firstSeen: "2026-09-03" }),
    ]);
    if (c?.kind !== "new_recurring") throw new Error("expected new_recurring");
    eq(c.amount, "37.99");
    expect(c.occurrences).toBe(3);
    expect(c.cadenceDays).toBe(30);
    expect(c.firstSeen).toBe("2026-09-03");
    expect(c.nextDate).toBe("2026-12-03");
  });

  it("the window edge is 90 days; 2 charges are not enough", () => {
    const at = (firstSeen: string, n = 3) =>
      changes([payee("X", Array(n).fill("10"), { firstSeen })]).map((c) => c.kind);
    expect(at(addDays(TODAY, -90))).toEqual(["new_recurring"]);
    expect(at(addDays(TODAY, -91))).toEqual([]);
    expect(at(addDays(TODAY, -10), 2)).toEqual([]);
    expect(at(addDays(TODAY, 1))).toEqual([]);
  });

  it("a new payee whose price also rose yields both, price rise first", () => {
    const kinds = changes([payee("New", ["60", "49", "49"], { firstSeen: "2026-09-03" })]).map(
      (c) => c.kind,
    );
    expect(kinds).toEqual(["price_up", "new_recurring"]);
  });

  it("empty input", () => {
    expect(changes([])).toEqual([]);
  });

  it("the changes feed the attention list as they are", () => {
    const fed: readonly AttentionPayeeChange[] = changes([payee("Netflix", ["60", "49", "49"])]);
    expect(fed).toHaveLength(1);
  });
});
