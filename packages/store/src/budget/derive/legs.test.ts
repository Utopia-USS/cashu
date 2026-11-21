// The budget.legs deriver on hand-made synthetic histories, every event applied alone (the
// incremental path) with the derived oracle after each. Synthetic data only.
import { describe, expect, it } from "vitest";
import { formatHlc } from "../../events/v1/hlc-format.js";
import type { RefEvent } from "../../testing/scenario-bridge.js";
import { Names, toEnvelopes } from "../../testing/scenario-bridge.js";
import { complete, syntheticDet } from "../../testing/scenarios.js";
import { openTestStore } from "../../testing/store.js";

function nrb(bban24: string): string {
  const check = 98n - (BigInt(`${bban24}252100`) % 97n);
  return `${check.toString().padStart(2, "0")}${bban24}`;
}
const N1 = nrb("114000000000000000000001");

type Spec = [type: string, gid: string, data: Record<string, unknown>];

describe("budget.legs deriver", () => {
  it("keeps the leg when an identity merge re-keys its withdrawal row", () => {
    const specs: Spec[] = [
      // A1 holds the IBAN first; the row is imported on A3 before A3 is opened
      ["account.identified", "A1", { iban: N1, keys: [`iban:${N1}`] }],
      // (an unrelated row on A1 first, so A1's test gid sorts before A3's: the old partition then
      // comes after the new one in the deriver's key order)
      [
        "txn.imported",
        "T-0",
        {
          account: "A1",
          dedupHash: "h0",
          occurrence: 0,
          amount: "-1.00",
          bookingDate: "2026-09-01",
        },
      ],
      [
        "txn.imported",
        "T-1",
        {
          account: "A3",
          dedupHash: "h1",
          occurrence: 0,
          amount: "-40.00",
          bookingDate: "2026-10-01",
        },
      ],
      ["txn.categorySet", "T-1", { category: "cash_withdrawal", source: "manual_txn" }],
      [
        "account.opened",
        "pool:PLN",
        {
          bank: "manual",
          name: "Gotówka",
          externalId: "cash:PLN",
          type: "cash",
          keys: ["ext:manual:cash:PLN"],
        },
      ],
      // A3 opens with the same IBAN: it joins A1's component, the row's key moves to the new root
      ["account.opened", "A3", { iban: N1, keys: [`iban:${N1}`] }],
    ];
    const events: RefEvent[] = specs.map(([type, gid, data], i) =>
      complete({
        eid: `01JH${String(i + 1).padStart(22, "0")}`,
        hlc: formatHlc({ wall: 1_793_448_000_100 + i, counter: i, device: "a".repeat(32) }),
        at: new Date(1_793_448_000_100 + i).toISOString(),
        type,
        gid,
        data,
      }),
    );
    const store = openTestStore();
    for (const e of toEnvelopes(events, new Names(), syntheticDet(events))) {
      store.applyEnvelopes([e]);
      expect(store.rederive().touchedTables).toEqual(new Set());
    }
    expect(
      store.read(
        "SELECT amount, category_source FROM transactions WHERE dedup_hash LIKE 'cashleg:%'",
      ),
    ).toEqual([{ amount: "40.00", category_source: "cash_leg" }]);
  });
});
