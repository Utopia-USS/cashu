// The recurring-payments list (`detectRecurringPayments`): the exact-amount `detectRecurring` plus
// amount drift (foreign-currency billing on a PLN card), an extra charge in a month and two-month
// histories of merchants filed as `subscriptions`. Synthetic rows only.

import { describe, expect, it } from "vitest";
import { D } from "../../decimal.js";
import { merchantKey } from "../ingestion/index.js";
import type { CategorizeRow } from "./effective.js";
import type { EngineContext } from "./engine.js";
import {
  detectRecurring,
  detectRecurringPayments,
  type RecurringCandidate,
  type RecurringListOptions,
} from "./recurring.js";
import { contextFrom, EMPTY_CONTEXT } from "./testing/engineRows.js";
import { monthly, row } from "./testing/rows.js";
import { NOT_SUBSCRIPTION } from "./testing/scenarios.js";

const asRecurring = (rows: readonly CategorizeRow[]) =>
  rows.map((r) => ({ ...r, decided: r.claim }));
const list = (
  rows: readonly CategorizeRow[],
  ctx: EngineContext = EMPTY_CONTEXT,
  opts: RecurringListOptions = {},
) => detectRecurringPayments(asRecurring(rows), ctx, NOT_SUBSCRIPTION, opts);
const signal = (rows: readonly CategorizeRow[], ctx: EngineContext = EMPTY_CONTEXT) =>
  detectRecurring(asRecurring(rows), ctx, NOT_SUBSCRIPTION);

/** Card charges of one merchant: `[date, amount]` outflows, the merchant as the counterparty. */
const charges = (cp: string, items: readonly (readonly [string, string])[], currency = "PLN") =>
  items.map(([date, amount]) =>
    row({ date, amount, cp, reference: "ZAKUP PRZY UZYCIU KARTY", currency }),
  );
const keyOf = (cp: string) => merchantKey(cp, "ZAKUP PRZY UZYCIU KARTY", null);
const find = (out: readonly RecurringCandidate[], cp: string) =>
  out.find((c) => c.counterparty === keyOf(cp));
const subscriptionRule = (cp: string): EngineContext =>
  contextFrom([], [[keyOf(cp), "subscriptions", "manual", false]], []);

describe("detectRecurringPayments: amount drift", () => {
  it("lists a foreign-currency subscription whose PLN amount drifts (103 / 116 / 116)", () => {
    const rows = charges("ACME CLOUD", [
      ["2026-07-04", "-103.00"],
      ["2026-08-04", "-116.00"],
      ["2026-09-04", "-116.00"],
    ]);
    expect(signal(rows)).toEqual([]); // the exact-amount rule misses it
    const c = find(list(rows), "ACME CLOUD");
    expect(c && [c.typicalAmount.toString(), c.currency, c.occurrences]).toEqual([
      "116.00",
      "PLN",
      3,
    ]);
    expect(c && [c.medianGapDays, c.monthsCovered, c.lastDate]).toEqual([31, 3, "2026-09-04"]);
  });

  it("lists small FX drift (46.17 / 46.21 / 47.58) with the median charge as typical", () => {
    const rows = charges("TOOLBOX AI", [
      ["2026-06-11", "-46.17"],
      ["2026-07-12", "-46.21"],
      ["2026-08-12", "-47.58"],
      ["2026-09-12", "-46.90"],
    ]);
    const c = find(list(rows), "TOOLBOX AI");
    expect(c && [c.typicalAmount.toString(), c.occurrences, c.medianGapDays]).toEqual([
      "46.90",
      4,
      31,
    ]);
  });

  it("splits charges above the tolerance (default 15%, configurable)", () => {
    const rows = charges("MEDIA HUB", [
      ["2026-07-04", "-100.00"],
      ["2026-08-04", "-116.00"],
      ["2026-09-04", "-100.00"],
    ]);
    expect(list(rows)).toEqual([]);
    expect(
      find(list(rows, EMPTY_CONTEXT, { amountTolerance: D("0.2") }), "MEDIA HUB"),
    ).toBeDefined();
    const edge = charges("MEDIA HUB", [
      ["2026-07-04", "-100.00"],
      ["2026-08-04", "-115.00"],
      ["2026-09-04", "-100.00"],
    ]);
    expect(find(list(edge), "MEDIA HUB")?.occurrences).toBe(3);
  });

  it("keeps a separate currency a separate charge", () => {
    const rows = [
      ...charges("ACME CLOUD", [
        ["2026-07-04", "-103.00"],
        ["2026-08-04", "-116.00"],
      ]),
      ...charges("ACME CLOUD", [["2026-09-04", "-25.00"]], "EUR"),
    ];
    expect(list(rows)).toEqual([]);
  });
});

describe("detectRecurringPayments: the subscriptions category", () => {
  const twoMonths = charges("STREAMLY", [
    ["2026-08-20", "-29.40"],
    ["2026-09-20", "-31.10"],
  ]);

  it("lists two monthly charges of a merchant filed as subscriptions", () => {
    const c = find(list(twoMonths, subscriptionRule("STREAMLY")), "STREAMLY");
    expect(c && [c.occurrences, c.medianGapDays, c.typicalAmount.toString()]).toEqual([
      2,
      31,
      "31.10",
    ]);
  });

  it("needs three charges without the category", () => {
    expect(list(twoMonths)).toEqual([]);
  });

  it("lets a subscriptions merchant skip more than one month", () => {
    const rows = charges("STREAMLY", [
      ["2026-03-20", "-29.40"],
      ["2026-04-20", "-29.60"],
      ["2026-06-20", "-30.10"],
      ["2026-07-20", "-30.30"],
      ["2026-08-20", "-30.80"],
      ["2026-10-20", "-31.10"],
    ]);
    expect(list(rows)).toEqual([]);
    expect(find(list(rows, subscriptionRule("STREAMLY")), "STREAMLY")?.occurrences).toBe(6);
  });

  it("never lists a merchant in a not-subscription category", () => {
    const rows = charges("SPOLDZIELNIA OSIEDLE", [
      ["2026-07-10", "-612.00"],
      ["2026-08-10", "-640.00"],
      ["2026-09-10", "-655.00"],
    ]);
    const ctx = contextFrom([], [[keyOf("SPOLDZIELNIA OSIEDLE"), "housing", "manual", true]], []);
    expect(list(rows, ctx)).toEqual([]);
  });
});

describe("detectRecurringPayments: an extra charge in a month", () => {
  it("tolerates one extra charge (a plan change)", () => {
    const rows = charges("DESIGNKIT", [
      ["2026-05-05", "-30.00"],
      ["2026-06-05", "-30.50"],
      ["2026-06-18", "-33.90"],
      ["2026-07-05", "-31.20"],
      ["2026-08-05", "-31.00"],
    ]);
    const c = find(list(rows), "DESIGNKIT");
    expect(c && [c.occurrences, c.monthsCovered, c.medianGapDays]).toEqual([5, 4, 31]);
  });

  it("tolerates a plan change that moves the billing day", () => {
    const rows = charges("DESIGNKIT", [
      ["2026-05-05", "-30.00"],
      ["2026-06-05", "-30.00"],
      ["2026-06-20", "-32.00"],
      ["2026-07-20", "-32.00"],
      ["2026-08-20", "-32.00"],
    ]);
    expect(find(list(rows), "DESIGNKIT")?.medianGapDays).toBe(31);
  });

  it("does not read weekly shopping of similar amounts as a monthly charge", () => {
    const amounts = ["-52.10", "-55.40", "-50.90", "-56.00", "-53.30", "-54.80"];
    const dates = ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22", "2026-07-29"];
    const weekly = [...dates, "2026-08-05", "2026-08-12", "2026-08-19", "2026-08-26"].map(
      (d, i) => [d, amounts[i % amounts.length] as string] as const,
    );
    expect(list(charges("SKLEP OSIEDLOWY", weekly))).toEqual([]);
  });
});

describe("detectRecurringPayments: spending categories", () => {
  it("keeps the exact-amount rule for a monthly shop in a spending category", () => {
    const rows = charges("NOVA TEST", [
      ["2026-06-06", "-106.50"],
      ["2026-07-06", "-107.50"],
      ["2026-08-06", "-108.50"],
      ["2026-09-06", "-109.50"],
    ]);
    const filed = (category: string) =>
      contextFrom([], [[keyOf("NOVA TEST"), category, "manual", false]], []);
    expect(list(rows, filed("groceries"))).toEqual([]);
    expect(list(rows, filed("fuel"))).toEqual([]);
    expect(find(list(rows), "NOVA TEST")?.occurrences).toBe(4); // unfiled: may drift
    expect(find(list(rows, filed("subscriptions")), "NOVA TEST")?.occurrences).toBe(4);
  });

  it("does not list monthly-ish purchases with more than one long gap", () => {
    const rows = charges("STACJA PALIW", [
      ["2026-03-02", "-250.00"],
      ["2026-03-29", "-262.00"],
      ["2026-05-14", "-255.00"],
      ["2026-06-12", "-270.00"],
      ["2026-07-31", "-248.00"],
      ["2026-08-28", "-266.00"],
    ]);
    expect(list(rows)).toEqual([]);
  });
});

describe("detectRecurringPayments: parity with the exact-amount rule", () => {
  const exactRows = () => [
    ...monthly("NETFLIX.COM", "-43.00"),
    ...monthly("KLUB SPORTOWY TEST", "-139.00", { day: 2 }),
    ...monthly("SPOTIFY TEST", "-9.99", { currency: "EUR", day: 9 }),
  ];

  it("returns exactly detectRecurring's candidates when every amount is fixed", () => {
    const rows = exactRows();
    expect(list(rows)).toEqual(signal(rows));
  });

  it("is a superset of detectRecurring's candidates", () => {
    const rows = [
      ...exactRows(),
      ...charges("ACME CLOUD", [
        ["2026-05-04", "-103.00"],
        ["2026-06-04", "-116.00"],
        ["2026-07-04", "-116.00"],
      ]),
    ];
    const out = list(rows);
    for (const c of signal(rows)) expect(out).toContainEqual(c);
    expect(find(out, "ACME CLOUD")).toBeDefined();
    const lasts = out.map((c) => c.lastDate);
    expect(lasts).toEqual([...lasts].sort().reverse());
  });

  it("keeps two fixed plans of one merchant as two entries", () => {
    const rows = [
      ...monthly("NETFLIX.COM", "-43.00"),
      ...monthly("NETFLIX.COM", "-49.00", { day: 20 }),
    ];
    expect(list(rows).map((c) => c.typicalAmount.toString())).toEqual(["49.00", "43.00"]);
    expect(list(rows)).toEqual(signal(rows));
  });
});
