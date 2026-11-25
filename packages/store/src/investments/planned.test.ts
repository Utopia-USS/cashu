// Planned deposits (S25 spec 4.13; scenario P1). Synthetic data only.
import { describe, expect, it } from "vitest";
import { openTestStore } from "../testing/store.js";
import { account, converge, DEV_B, Events, row, rows, ulid } from "./testing/kit.js";

const ACC = "01JE0000000000000000000A01";
const P1 = ulid(1);
const P2 = ulid(2);
const TX = ulid(50);
const TX2 = ulid(51);

describe("inv_planned_deposits", () => {
  it("creates planned, cancels, books with booked_at / updated_at", () => {
    const store = openTestStore();
    const ev = new Events();
    store.applyEnvelopes([account(ev, ACC)]);
    const r = store.applyEnvelopes([
      ev.make("plannedDeposit.created", P1, { account: ACC }, { wall: 10 }),
      ev.make("plannedDeposit.created", P2, {}, { wall: 11 }),
    ]);
    expect([...r.touchedTables]).toEqual(["inv_planned_deposits"]);
    store.applyEnvelopes([
      ev.make("plannedDeposit.booked", P1, { txn: TX }, { wall: 20 }),
      ev.make("plannedDeposit.cancelled", P2, {}, { wall: 21 }),
    ]);
    expect(row(store, "inv_planned_deposits", P1)).toMatchObject({
      account_id: ACC,
      amount: "500",
      status: "booked",
      booked_txn_id: TX, // as named; readers resolve members through inv_transaction_members
      booked_at: "2026-10-31 12:00:00.020000",
      created_at: "2026-10-31 12:00:00.010000",
      updated_at: "2026-10-31 12:00:00.020000",
    });
    expect(row(store, "inv_planned_deposits", P2)).toMatchObject({
      status: "cancelled",
      account_id: null,
      booked_txn_id: null,
      updated_at: "2026-10-31 12:00:00.021000",
    });
  });

  it("P1: two bookings of one plan (FWW) and one transaction booking two plans (GUARD O10)", () => {
    const a = new Events();
    const b = new Events(DEV_B, "01JB");
    const events = [
      a.make("plannedDeposit.created", P1, {}, { wall: 10 }),
      a.make("plannedDeposit.created", P2, {}, { wall: 11 }),
      a.make("plannedDeposit.booked", P1, { txn: TX }, { wall: 20 }),
      b.make("plannedDeposit.booked", P1, { txn: TX2 }, { wall: 21 }), // FWW loser
      b.make("plannedDeposit.booked", P2, { txn: TX }, { wall: 22 }), // TX already books P1
      b.make("plannedDeposit.cancelled", P1, {}, { wall: 23 }), // FWW loser
    ];
    converge(events, (store) => {
      expect(
        rows(store, "inv_planned_deposits").map((p) => [p.gid, p.status, p.booked_txn_id]),
      ).toEqual([
        [P1, "booked", TX],
        [P2, "planned", null],
      ]);
    });
  });
});
