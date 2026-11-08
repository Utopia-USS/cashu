// Investments transactions (S25 spec 4.4, D-S2). Synthetic data only.
import { describe, expect, it } from "vitest";
import { openTestStore } from "../testing/store.js";
import { account, converge, DEV_B, det, Events, instrument, rows, ulid } from "./testing/kit.js";

const ACC = "01JE0000000000000000000A01";
const A2 = "01JE0000000000000000000A02";
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

describe("inv_transactions + inv_transaction_members", () => {
  it("creates a row per (account, dedupHash), resolves the instrument, keeps the batch as named", () => {
    const store = openTestStore();
    const ev = new Events();
    const inst = instrument(ev, ["xtb", "TST.PL"]);
    const batch = ulid(9);
    store.applyEnvelopes([account(ev, ACC), ...inst.events]);
    const g = det("inv_transactions", ACC, H1);
    const r = store.applyEnvelopes([
      ev.make("invTxn.imported", g, {
        account: ACC,
        dedupHash: H1,
        instrument: inst.gid,
        batch,
        createdAt: "2026-03-02T10:00:00.000123Z",
      }),
    ]);
    expect([...r.touchedTables].sort()).toEqual(["inv_transaction_members", "inv_transactions"]);
    expect(rows(store, "inv_transactions")).toEqual([
      expect.objectContaining({
        gid: g,
        account_id: ACC,
        instrument_id: inst.gid,
        import_batch_id: batch, // missing target: kept as named, the reader's join decides
        type: "buy",
        quantity: "10",
        gross_amount: "125.00",
        source: "import",
        dedup_hash: H1,
        created_at: "2026-03-02 10:00:00.000123",
      }),
    ]);
    expect(rows(store, "inv_transaction_members")).toEqual([{ gid: g, transaction_id: g }]);
  });

  it("keeps two identical manual entries as two rows (m1)", () => {
    const store = openTestStore();
    const ev = new Events();
    const m1 = ulid(1);
    const m2 = ulid(2);
    store.applyEnvelopes([
      ev.make("invTxn.imported", m1, { account: ACC, source: "manual", dedupHash: `manual:${m1}` }),
      ev.make("invTxn.imported", m2, { account: ACC, source: "manual", dedupHash: `manual:${m2}` }),
    ]);
    expect(rows(store, "inv_transactions").map((r) => r.gid)).toEqual([m1, m2]);
  });

  it("collapses the same broker row of two merged account gids; every member maps to the row", () => {
    const a = new Events();
    const b = new Events(DEV_B, "01JB");
    const ga = det("inv_transactions", ACC, H1);
    const gb = det("inv_transactions", A2, H1);
    const events = [
      account(a, ACC, ["ext:xtb:7"], { wall: 1 }),
      account(b, A2, ["ext:xtb:7"], { wall: 2 }),
      a.make("invTxn.imported", ga, { account: ACC, dedupHash: H1, quantity: "1" }, { wall: 10 }),
      b.make("invTxn.imported", gb, { account: A2, dedupHash: H1, quantity: "2" }, { wall: 11 }),
      b.make(
        "invTxn.imported",
        det("inv_transactions", A2, H2),
        {
          account: A2,
          dedupHash: H2,
        },
        { wall: 12 },
      ),
    ];
    converge(events, (store) => {
      const txns = rows(store, "inv_transactions");
      expect(txns.map((t) => [t.account_id, t.dedup_hash, t.quantity])).toEqual(
        expect.arrayContaining([
          [ACC, H1, "1"], // first applied member supplies the columns
          [ACC, H2, "10"],
        ]),
      );
      expect(txns).toHaveLength(2);
      const anchor = txns.find((t) => t.dedup_hash === H1)?.gid;
      expect(anchor).toBe(ga);
      const members = rows(store, "inv_transaction_members").filter((m) => m.transaction_id === ga);
      expect(members.map((m) => m.gid).sort()).toEqual([ga, gb].sort());
    });
  });
});
