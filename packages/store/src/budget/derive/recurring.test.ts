// The recurring deriver (`budget.recurring`) and the phone's recurring reads over it on hand-built
// synthetic scripts: the cases a random script rarely builds. Each step's batch is applied, then the
// stored records equal the recompute from the book, the incremental derivation equals `deriveAll`, and
// `recurringCharges` / `payeeChargeHistories` equal the book-based reads. Synthetic data only.
import { describe, expect, it } from "vitest";
import { formatHlc } from "../../events/v1/hlc-format.js";
import type { Step } from "../../testing/category-script.js";
import {
  expectRecurringQueriesEqual,
  expectRecurringRecomputed,
  recurringState,
} from "../../testing/recurring-oracle.js";
import { Names, type RefEvent, toEnvelopes } from "../../testing/scenario-bridge.js";
import { complete, syntheticDet } from "../../testing/scenarios.js";
import { openTestStore } from "../../testing/store.js";
import { recurringCharges } from "../companion-queries.js";

const DEVICE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** Apply each batch in turn (one store, one name table); `each` runs after every batch. */
function applied(
  batches: readonly (readonly Step[])[],
  each: (s: ReturnType<typeof openTestStore>) => void,
) {
  const steps = batches.flat();
  const events: RefEvent[] = steps.map((s, i) =>
    complete({
      eid: `01JE${String(i + 1).padStart(22, "0")}`,
      hlc: formatHlc({ wall: 1_793_448_000_000 + i, counter: 0, device: DEVICE }),
      at: new Date(1_793_448_000_000 + i).toISOString(),
      type: s.type,
      gid: s.gid,
      data: s.data,
    }),
  );
  const envs = toEnvelopes(events, new Names(), syntheticDet(events));
  const store = openTestStore();
  let at = 0;
  for (const b of batches) {
    store.applyEnvelopes(envs.slice(at, at + b.length));
    at += b.length;
    expectRecurringRecomputed(store);
    const incremental = recurringState(store);
    store.rederive();
    expect(recurringState(store)).toEqual(incremental);
    expectRecurringQueriesEqual(store);
    each(store);
  }
  return store;
}

const opened: Step = {
  type: "account.opened",
  gid: "A1",
  data: { externalId: "k1", keys: ["ext:mbank:k1"] },
};

const charge = (
  h: string,
  date: string,
  amount: string,
  extra: Record<string, unknown> = {},
): Step => ({
  type: "txn.imported",
  gid: `T-A1-${h}-0`,
  data: {
    account: "A1",
    dedupHash: h,
    occurrence: 0,
    bookingDate: date,
    amount,
    counterpartyName: "NETFLIX DEMO",
    ...extra,
  },
});

const monthly = (from: number, to: number, amount: string, extra: Record<string, unknown> = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => {
    const m = String(from + i).padStart(2, "0");
    return charge(`n${m}`, `2026-${m}-04`, amount, extra);
  });

const read = (s: ReturnType<typeof openTestStore>) => s.read.bind(s);

describe("budget.recurring", () => {
  it("forms the series over the active candidates of a group with a stale one", () => {
    // 43.00 for three months (stale by October), 60.00 since April, and a 44.00 charge filed as
    // housing (no recurring member) on the 60.00 series' next date: with the stale candidate gone it
    // continues that series (a price change), with it it would be the stale one's.
    const store = applied(
      [
        [opened, ...monthly(1, 3, "-43.00"), ...monthly(4, 9, "-60.00")],
        [
          charge("n10", "2026-10-04", "-44.00"),
          {
            type: "txn.categorySet",
            gid: "T-A1-n10-0",
            data: { category: "housing", source: "manual_txn" },
          },
        ],
      ],
      () => {},
    );
    const stored = store.read<{ typical_amount: string; charge_last: string }>(
      "SELECT typical_amount, charge_last FROM fold_recurring ORDER BY typical_amount",
    );
    expect(stored).toEqual([
      { typical_amount: "43.00", charge_last: "2026-10-04" },
      { typical_amount: "60.00", charge_last: "2026-09-04" },
    ]);
    const charges = recurringCharges(read(store), "2026-10-31");
    expect(charges.map((c) => [c.key, c.lastDate])).toEqual([
      ["NETFLIX DEMO:PLN:60.00", "2026-10-04"],
    ]);
  });

  it("leaves out charges dated after today", () => {
    const store = applied([[opened, ...monthly(1, 6, "-43.00")]], () => {});
    const charges = recurringCharges(read(store), "2026-04-10");
    expect(charges.map((c) => [c.key, c.lastDate])).toEqual([
      ["NETFLIX DEMO:PLN:43.00", "2026-04-04"],
    ]);
    // two charges by then: a merchant the seeds file as a subscription needs two cycles
    expectRecurringQueriesEqual(store, ["2026-02-10", "2026-01-20"]);
    expect(recurringCharges(read(store), "2026-02-10").map((c) => c.lastDate)).toEqual([
      "2026-02-04",
    ]);
    expect(recurringCharges(read(store), "2026-01-20")).toEqual([]);
  });

  it("re-judges a cash account's unclaimed rows when their merchant's rule changes", () => {
    const rule = (category: string): Step => ({
      type: "categoryRule.set",
      gid: "R-NETFLIX",
      data: { merchantKey: "NETFLIX DEMO", category, source: "manual", locked: true },
    });
    const counts: number[] = [];
    applied(
      [
        [
          opened,
          { type: "account.typeSet", gid: "A1", data: { type: "cash" } },
          ...monthly(1, 6, "-43.00"),
        ],
        [rule("housing")],
        [rule("entertainment")],
      ],
      (s) => {
        expect(s.read("SELECT count(*) AS n FROM fold_recurring_rows WHERE engine = 1")).toEqual([
          { n: 6 },
        ]);
        counts.push(s.read<{ n: number }>("SELECT count(*) AS n FROM fold_recurring")[0]?.n ?? 0);
      },
    );
    expect(counts).toEqual([1, 0, 1]);
  });

  it("re-judges a cash account's unclaimed rows when a payment pattern changes", () => {
    const pattern = (text: string | null): Step => ({
      type: "loan.paymentMatchingSet",
      gid: "LOAN-A1",
      data: { account: "A1", paymentIban: null, paymentText: text },
    });
    const counts: number[] = [];
    applied(
      [
        [
          opened,
          { type: "account.typeSet", gid: "A1", data: { type: "cash" } },
          ...monthly(1, 6, "-43.00", { reference: "RATA 1/120" }),
          {
            type: "loan.termsSet",
            gid: "LOAN-A1",
            data: {
              account: "A1",
              principal: "100.00",
              annualRate: "6.5",
              termMonths: 120,
              startDate: "2026-01-10",
              originationDate: null,
            },
          },
        ],
        [pattern("RATA")],
        [pattern(null)],
      ],
      (s) =>
        counts.push(s.read<{ n: number }>("SELECT count(*) AS n FROM fold_recurring")[0]?.n ?? 0),
    );
    expect(counts).toEqual([1, 0, 1]);
  });
});
