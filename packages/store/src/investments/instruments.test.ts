// Instruments + aliases (S25 spec 4.1, D-S5). Synthetic data only.
import { describe, expect, it } from "vitest";
import { openTestStore } from "../testing/store.js";
import { claim, converge, DEV_B, Events, instrument, row, rows, ulid } from "./testing/kit.js";

describe("inv_instruments + inv_instrument_aliases", () => {
  it("creates the row from the create and an alias row from the claim", () => {
    const store = openTestStore();
    const ev = new Events();
    const i = instrument(ev, ["isin", "PLTEST000001"], {
      name: "Test SA",
      symbol: "TST",
      isin: "PLTEST000001",
      tags: ["dywidenda"],
      stamps: { created_at: "2026-01-02T03:04:05.123456Z", updated_at: "2026-01-03T00:00:00Z" },
    });
    const r = store.applyEnvelopes(i.events);
    expect([...r.touchedTables].sort()).toEqual(["inv_instrument_aliases", "inv_instruments"]);
    expect(row(store, "inv_instruments", i.gid)).toMatchObject({
      name: "Test SA",
      currency: "PLN",
      asset_class: "equity",
      symbol: "TST",
      isin: "PLTEST000001",
      tags: ["dywidenda"],
      needs_classification: 0,
      valuation_mode: "market",
      status: "active",
      created_at: "2026-01-02 03:04:05.123456",
      updated_at: "2026-01-03 00:00:00.000000",
    });
    expect(rows(store, "inv_instrument_aliases")).toEqual([
      expect.objectContaining({
        instrument_id: i.gid,
        namespace: "isin",
        value: "PLTEST000001",
        guessed: 0,
      }),
    ]);
  });

  it("applies instrument.updated LWW-F per field and bumps updated_at", () => {
    const store = openTestStore();
    const ev = new Events();
    const i = instrument(ev, ["yahoo", "TST.WA"], { name: "A", sector: "x" });
    store.applyEnvelopes(i.events);
    store.applyEnvelopes([
      ev.make("instrument.updated", i.gid, { name: "B" }, { wall: 50 }),
      ev.make("instrument.updated", i.gid, { name: "C", region: "PL" }, { wall: 60 }),
    ]);
    const r = row(store, "inv_instruments", i.gid);
    expect(r).toMatchObject({ name: "C", region: "PL", sector: "x" });
    expect(r?.updated_at).toBe("2026-10-31 12:00:00.060000");
  });

  it("shows no row for an update or an alias claim without a create (alias row shown)", () => {
    const store = openTestStore();
    const ev = new Events();
    const g = ulid(1);
    store.applyEnvelopes([
      ev.make("instrument.updated", g, { name: "X" }),
      claim(ev, g, ["stooq", "xyz"]),
    ]);
    expect(rows(store, "inv_instruments")).toEqual([]);
    expect(rows(store, "inv_instrument_aliases")).toHaveLength(1);
    store.applyEnvelopes([ev.make("instrument.created", g, { name: "Created" }, { wall: 0 })]);
    expect(row(store, "inv_instruments", g)?.name).toBe("X"); // the update stands over the create
  });

  it("D-S5: a collision keeps the root's create, fills market identity, keeps its currency", () => {
    const a = new Events();
    const b = new Events(DEV_B, "01JB");
    // device a creates under an isin alias, device b under a yahoo alias; each claims the other's
    const ia = instrument(
      a,
      ["isin", "PLTEST000002"],
      {
        name: "Member name",
        isin: "PLTEST000002",
        currency: "PLN",
      },
      { wall: 10 },
    );
    const ib = instrument(
      b,
      ["yahoo", "TST2.WA"],
      {
        name: "Other name",
        symbol: "TST2",
        mic: "XWAR",
        currency: "EUR",
        assetClass: "etf",
      },
      { wall: 20 },
    );
    const events = [
      ...ia.events,
      ...ib.events,
      claim(a, ia.gid, ["yahoo", "TST2.WA"], { wall: 30 }),
      claim(b, ib.gid, ["isin", "PLTEST000002"], { wall: 40 }),
    ];
    converge(events, (store) => {
      const all = rows(store, "inv_instruments");
      expect(all).toHaveLength(1);
      // The first collision in the order is a's claim of b's alias: a folds into b, the holder.
      expect(all[0]).toMatchObject({
        gid: ib.gid,
        name: "Other name",
        currency: "EUR", // the root's, never a member's
        asset_class: "etf",
        symbol: "TST2",
        mic: "XWAR",
        isin: "PLTEST000002", // filled from the member's create
      });
      expect(rows(store, "inv_instrument_aliases").map((r) => r.instrument_id)).toEqual([
        ib.gid,
        ib.gid,
      ]);
    });
  });

  it("an owner merge re-keys the source's aliases to the target's root", () => {
    const ev = new Events();
    const s = instrument(ev, ["stooq", "src"], { name: "S" }, { wall: 10 });
    const t = instrument(ev, ["stooq", "dst"], { name: "T" }, { wall: 20 });
    const merged = ev.make(
      "instrument.merged",
      s.gid,
      { source: s.gid, target: t.gid, reason: "owner" },
      { wall: 30 },
    );
    converge([...s.events, ...t.events, merged], (store) => {
      expect(rows(store, "inv_instruments").map((r) => [r.gid, r.name])).toEqual([[t.gid, "T"]]);
      expect(new Set(rows(store, "inv_instrument_aliases").map((r) => r.instrument_id))).toEqual(
        new Set([t.gid]),
      );
    });
  });

  it("declares the Python indexes", () => {
    const store = openTestStore();
    const idx = store.read<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('inv_instruments', 'inv_instrument_aliases')",
    );
    expect(idx.map((i) => i.name).sort()).toEqual(
      expect.arrayContaining([
        "inv_instrument_aliases_instrument_id_ix",
        "inv_instrument_aliases_namespace_value_uq",
        "inv_instruments_isin_ix",
        "inv_instruments_symbol_ix",
      ]),
    );
  });
});
