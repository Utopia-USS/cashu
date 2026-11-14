// The budget.transfers deriver (S24b, D-24.1 / D-24.2) on hand-made synthetic histories, one
// behaviour per test, every event applied alone (the incremental path), with the derived oracle, the
// transfer recompute and the category recompute after each event. The random search is
// transfers.property(.exhaustive).test.ts. Data-safety rule 5: only a counterparty IBAN pairs rows.
import { describe, expect, it } from "vitest";
import { formatHlc } from "../../events/v1/hlc-format.js";
import type { Store } from "../../materialize.js";
import { viewHash } from "../../snapshot.js";
import { expectCategoriesRecomputed } from "../../testing/categories-oracle.js";
import type { RefEvent } from "../../testing/scenario-bridge.js";
import { Names, toEnvelopes } from "../../testing/scenario-bridge.js";
import { complete, syntheticDet } from "../../testing/scenarios.js";
import { EventFactory, openTestStore } from "../../testing/store.js";
import { expectTransfersRecomputed } from "../../testing/transfers-oracle.js";

function nrb(bban24: string): string {
  const check = 98n - (BigInt(`${bban24}252100`) % 97n);
  return `${check.toString().padStart(2, "0")}${bban24}`;
}
const N1 = nrb("114000000000000000000001");
const N2 = nrb("114000000000000000000002");
/** Fails the checksum: never an identity key, still the account's match key (D-08.1). */
const RAW = "99114000000000000000000003";
const FOREIGN = "DE89370400440532013000";

type Spec = [type: string, gid: string, data: Record<string, unknown>, wall?: number];

/** Apply `specs` one event at a time (wall = position unless given); check every oracle after each. */
function history(specs: readonly Spec[]): { store: Store; names: Names } {
  const events: RefEvent[] = specs.map(([type, gid, data, at], i) => {
    const w = at ?? 100 + i;
    return complete({
      eid: `01JG${String(i + 1).padStart(22, "0")}`,
      hlc: formatHlc({ wall: 1_793_448_000_000 + w, counter: i, device: "a".repeat(32) }),
      at: new Date(1_793_448_000_000 + w).toISOString(),
      type,
      gid,
      data,
    });
  });
  const names = new Names();
  const store = openTestStore();
  for (const e of toEnvelopes(events, names, syntheticDet(events))) {
    store.applyEnvelopes([e]);
    expect(store.rederive().touchedTables).toEqual(new Set());
    expectTransfersRecomputed(store);
    expectCategoriesRecomputed(store);
  }
  const hash = viewHash(store).hash;
  store.rebuild();
  expect(viewHash(store).hash).toBe(hash);
  return { store, names };
}

const A1: Spec = ["account.opened", "A1", { iban: N1, keys: [`iban:${N1}`] }];
const A2: Spec = ["account.opened", "A2", { iban: RAW, externalId: "k2", keys: ["ext:mbank:k2"] }];
const A3: Spec = ["account.opened", "A3", { externalId: "k3", keys: ["ext:mbank:k3"] }];

const imp = (
  row: string,
  account: string,
  amount: string,
  date: string,
  iban: string | null = null,
  wall?: number,
): Spec => [
  "txn.imported",
  `T-${row}`,
  {
    account,
    dedupHash: row,
    occurrence: 0,
    amount,
    bookingDate: date,
    counterpartyName: "PRZELEW WLASNY",
    counterpartyIban: iban,
  },
  wall,
];

function flags(store: Store, names: Names, row: string): [number, string | null] {
  const r = store.read<{ is_internal_transfer: number; transfer_group_id: string | null }>(
    "SELECT is_internal_transfer, transfer_group_id FROM transactions WHERE gid = ?",
    names.gid(`T-${row}`),
  )[0];
  return [r?.is_internal_transfer ?? -1, r?.transfer_group_id ?? null];
}

describe("budget.transfers deriver", () => {
  it("releases suppression once on an unrelated bank import, but not on a cash expense", () => {
    const pool: Spec = [
      "account.opened",
      "pool:PLN",
      {
        bank: "manual",
        name: "Gotówka",
        externalId: "cash:PLN",
        type: "cash",
        keys: ["ext:manual:cash:PLN"],
      },
    ];
    const { store, names } = history([
      A1,
      A2,
      pool,
      imp("release-out", "A1", "-10.00", "2026-10-01", RAW),
      imp("release-in", "A2", "10.00", "2026-10-02"),
    ]);
    const f = new EventFactory();
    store.applyEnvelopes([
      f.make(
        "transferRun.started",
        "01JC0000000000000000000010",
        {
          reset: true,
          maxDays: -1,
          pairCount: 0,
        },
        { wall: 300 },
      ),
    ]);
    expect(flags(store, names, "release-out")[0]).toBe(0);
    const expense = complete({
      eid: "01JG0000000000000000000010",
      hlc: formatHlc({ wall: 1_793_448_000_400, counter: 0, device: "a".repeat(32) }),
      at: new Date(1_793_448_000_400).toISOString(),
      type: "txn.cashExpenseAdded",
      gid: "X-release",
      data: {
        account: "pool:PLN",
        bookingDate: "2026-10-03",
        amount: "-5.00",
        title: "Kawa",
        category: "food",
      },
    });
    store.applyEnvelopes(toEnvelopes([expense], names, syntheticDet([expense])));
    expect(flags(store, names, "release-out")[0]).toBe(0);
    const [type, gid, data] = imp("unrelated", "A1", "-99.00", "2026-10-03");
    const imported = complete({
      eid: "01JG0000000000000000000011",
      hlc: formatHlc({ wall: 1_793_448_000_401, counter: 0, device: "a".repeat(32) }),
      at: new Date(1_793_448_000_401).toISOString(),
      type,
      gid,
      data,
    });
    store.applyEnvelopes(toEnvelopes([imported], names, syntheticDet([imported])));
    expect(flags(store, names, "release-out")).toEqual([1, names.gid("T-release-out")]);
    const hash = viewHash(store).hash;
    store.rebuild();
    expect(viewHash(store).hash).toBe(hash);
  });

  it("activates only complete runs, including a zero-pair reset, and rebuilds the same view", () => {
    const { store, names } = history([
      A1,
      A2,
      imp("claim-out", "A1", "-100.00", "2026-10-01", RAW),
      imp("claim-in", "A2", "100.00", "2026-10-02"),
    ]);
    const f = new EventFactory();
    const zero = f.make(
      "transferRun.started",
      "01JC0000000000000000000001",
      { reset: true, maxDays: -1, pairCount: 0 },
      { wall: 300 },
    );
    store.applyEnvelopes([zero]);
    expect(flags(store, names, "claim-out")[0]).toBe(0);
    const run = "01JC0000000000000000000002";
    const header = f.make(
      "transferRun.started",
      run,
      { reset: false, maxDays: 3, pairCount: 1 },
      { wall: 301 },
    );
    const claim = f.make(
      "transferPair.claimed",
      run,
      {
        run,
        out: names.gid("T-claim-out"),
        in: names.gid("T-claim-in"),
        ordinal: 0,
      },
      { wall: 302 },
    );
    store.applyEnvelopes([header]);
    expect(flags(store, names, "claim-out")[0]).toBe(0);
    store.applyEnvelopes([claim]);
    expect(flags(store, names, "claim-out")).toEqual([1, names.gid("T-claim-out")]);
    // a newer reset run whose claims have not all arrived (a sync frame boundary) keeps the
    // previous complete run active
    store.applyEnvelopes([
      f.make(
        "transferRun.started",
        "01JC0000000000000000000005",
        { reset: true, maxDays: 3, pairCount: 2 },
        { wall: 302 },
      ),
    ]);
    expect(flags(store, names, "claim-out")).toEqual([1, names.gid("T-claim-out")]);
    const later = f.make(
      "transferRun.started",
      "01JC0000000000000000000003",
      {
        reset: true,
        maxDays: -1,
        pairCount: 0,
      },
      { wall: 303 },
    );
    store.applyEnvelopes([later]);
    expect(flags(store, names, "claim-out")[0]).toBe(0);
    const shuffledRun = "01JC0000000000000000000004";
    const shuffledHeader = f.make(
      "transferRun.started",
      shuffledRun,
      {
        reset: false,
        maxDays: 3,
        pairCount: 1,
      },
      { wall: 304 },
    );
    const shuffledClaim = f.make(
      "transferPair.claimed",
      shuffledRun,
      {
        run: shuffledRun,
        out: names.gid("T-claim-out"),
        in: names.gid("T-claim-in"),
        ordinal: 0,
      },
      { wall: 305 },
    );
    store.applyEnvelopes([shuffledClaim]);
    expect(flags(store, names, "claim-out")[0]).toBe(0);
    store.applyEnvelopes([shuffledHeader]);
    expect(flags(store, names, "claim-out")[0]).toBe(1);
    store.applyEnvelopes([
      f.make(
        "transferPair.claimed",
        shuffledRun,
        {
          run: shuffledRun,
          out: names.gid("T-claim-out"),
          in: names.gid("T-claim-in"),
          ordinal: 1,
        },
        { wall: 306 },
      ),
    ]);
    expect(flags(store, names, "claim-out")[0]).toBe(1);
    const hash = viewHash(store);
    store.rebuild();
    expect(flags(store, names, "claim-out")[0]).toBe(1);
    expect(viewHash(store).tables).toEqual(hash.tables);
  });
  it("pairs an outflow and an inflow by the counterparty IBAN; the group id is the outflow's gid", () => {
    const { store, names } = history([
      A1,
      A2,
      imp("out", "A1", "-100.00", "2026-10-01", RAW),
      imp("in", "A2", "100.00", "2026-10-02"),
    ]);
    const group = names.gid("T-out");
    expect(flags(store, names, "out")).toEqual([1, group]);
    expect(flags(store, names, "in")).toEqual([1, group]);
    // the inflow carries no own IBAN: its category follows from the flag (S24c reads it)
    const cat = store.read<{ category: string | null }>(
      "SELECT category FROM transactions ORDER BY gid",
    );
    expect(new Set(cat.map((c) => c.category))).toEqual(new Set(["transfer"]));
  });

  it("never pairs by amount and date alone, nor to a foreign IBAN (rule 5)", () => {
    const { store, names } = history([
      A1,
      A2,
      imp("o1", "A1", "-100.00", "2026-10-01"),
      imp("o2", "A1", "-100.00", "2026-10-01", FOREIGN),
      imp("in", "A2", "100.00", "2026-10-01"),
    ]);
    for (const row of ["o1", "o2", "in"]) expect(flags(store, names, row)).toEqual([0, null]);
  });

  it("pairs within three days, not four; never on one account; zero never pairs", () => {
    const { store, names } = history([
      A1,
      A2,
      imp("o3", "A1", "-30.00", "2026-10-01", RAW),
      imp("i3", "A2", "30.00", "2026-10-04"),
      imp("o4", "A1", "-40.00", "2026-10-01", RAW),
      imp("i4", "A2", "40.00", "2026-10-05"),
      imp("os", "A1", "-50.00", "2026-10-01", N1),
      imp("is", "A1", "50.00", "2026-10-01", N1),
      imp("oz", "A1", "0.00", "2026-10-01", RAW),
      imp("iz", "A2", "-0.00", "2026-10-01", N1),
    ]);
    expect(flags(store, names, "o3")[0]).toBe(1);
    for (const row of ["o4", "i4", "os", "is", "oz", "iz"]) {
      expect(flags(store, names, row)).toEqual([0, null]);
    }
    expect(
      store.read<{ amount_key: string }>(
        "SELECT amount_key FROM fold_txn_keys ORDER BY amount_key",
      ),
    ).toEqual(
      ["", "", "30.00", "30.00", "40.00", "40.00", "50.00", "50.00"].map((k) => ({
        amount_key: k,
      })),
    );
  });

  it("takes the nearest day, then the earliest anchor; a late but earlier-anchored inflow wins", () => {
    const { store, names } = history([
      A1,
      A2,
      imp("out", "A1", "-70.00", "2026-10-05", RAW),
      imp("far", "A2", "70.00", "2026-10-07"),
      imp("near", "A2", "70.00", "2026-10-06"),
      // same distance as `near`, delivered last but anchored before every other row
      imp("early", "A2", "70.00", "2026-10-04", null, 1),
    ]);
    expect(flags(store, names, "early")).toEqual([1, names.gid("T-out")]);
    expect(flags(store, names, "near")).toEqual([0, null]);
    expect(flags(store, names, "far")).toEqual([0, null]);
  });

  it("re-matches every key when an account learns its IBAN, and keeps a removed account's", () => {
    const { store, names } = history([
      A1,
      A3,
      imp("out", "A1", "-12.50", "2026-10-01", N2),
      imp("in", "A3", "12.50", "2026-10-01"),
      ["account.identified", "A3", { iban: N2, keys: [`iban:${N2}`] }],
      ["account.removed", "A3", {}],
    ]);
    expect(flags(store, names, "out")).toEqual([1, names.gid("T-out")]);
    expect(flags(store, names, "in")).toEqual([1, names.gid("T-out")]);
  });

  it("pairs across currencies, as Python does (the amount key carries no currency)", () => {
    const { store, names } = history([
      A1,
      [
        "account.opened",
        "E1",
        { iban: RAW, currency: "EUR", externalId: "e1", keys: ["ext:mbank:e1"] },
      ],
      imp("out", "A1", "-100.00", "2026-10-01", RAW),
      [
        "txn.imported",
        "T-in",
        {
          account: "E1",
          dedupHash: "in",
          occurrence: 0,
          amount: "100.00",
          currency: "EUR",
          bookingDate: "2026-10-01",
          counterpartyName: "PRZELEW",
          counterpartyIban: null,
        },
      ],
    ]);
    expect(store.read("SELECT currency FROM transactions ORDER BY currency")).toEqual([
      { currency: "EUR" },
      { currency: "PLN" },
    ]);
    expect(flags(store, names, "in")).toEqual([1, names.gid("T-out")]);
  });

  it("an inflow without the IBAN pairs through the outflow's counterparty, either direction", () => {
    const { store, names } = history([
      A1,
      A2,
      imp("out", "A2", "-8.00", "2026-10-02"),
      imp("in", "A1", "8.00", "2026-10-02", RAW),
    ]);
    expect(flags(store, names, "in")).toEqual([1, names.gid("T-out")]);
  });

  it("re-matches when an account opens after its rows, with only its match key new", () => {
    const { store, names } = history([
      A1,
      imp("out", "A1", "-9.99", "2026-10-01", RAW),
      imp("in", "A2", "9.99", "2026-10-01"),
      A2,
    ]);
    expect(flags(store, names, "in")).toEqual([1, names.gid("T-out")]);
  });

  it("frees the partner of a deleted row, which then pairs with the next candidate", () => {
    // a cash pool that carries an IBAN (Python never creates one; the store must still be exact)
    const pool: Spec = [
      "account.opened",
      "pool:PLN",
      {
        bank: "manual",
        name: "Gotówka",
        iban: N2,
        externalId: "cash:PLN",
        type: "cash",
        keys: ["ext:manual:cash:PLN"],
      },
    ];
    const expense = (x: string, wall?: number): Spec => [
      "txn.cashExpenseAdded",
      x,
      {
        account: "pool:PLN",
        bookingDate: "2026-10-03",
        amount: "-5.00",
        title: "Kawa",
        category: "food",
      },
      wall,
    ];
    const { store, names } = history([
      A1,
      pool,
      expense("X2"),
      imp("in", "A1", "5.00", "2026-10-03", N2),
      expense("X1", 1),
      ["txn.deleted", "X1", {}],
    ]);
    expect(flags(store, names, "in")).toEqual([1, names.gid("X2")]);
  });
});

/** A pool account carrying an IBAN (Python never creates one; the store must still be exact). */
const POOL_N = "11114000000000000000000009";
const pool: Spec = [
  "account.opened",
  "pool:PLN",
  {
    bank: "manual",
    name: "Gotówka",
    iban: POOL_N,
    externalId: "cash:PLN",
    type: "cash",
    keys: ["ext:manual:cash:PLN"],
  },
];
const base: Spec[] = [
  A1,
  A2,
  pool,
  imp("w", "A1", "-40.00", "2026-10-01"),
  ["txn.categorySet", "T-w", { category: "cash_withdrawal", source: "manual_txn" }],
  imp("o", "A2", "-40.00", "2026-10-01", POOL_N),
];
describe("budget.transfers deriver: legs changed by an account-only change", () => {
  it("typeSet of the source account to cash drops the leg; its partner is freed", () => {
    const { store, names } = history([...base, ["account.typeSet", "A1", { type: "cash" }]]);
    expect(flags(store, names, "o")).toEqual([0, null]);
  });
  it("the leg pairs first, and pairs again when the account is a bank account again", () => {
    const back = history([
      ...base,
      ["account.typeSet", "A1", { type: "cash" }],
      ["account.typeSet", "A1", { type: "checking" }],
    ]);
    expect(flags(back.store, back.names, "o")[0]).toBe(1);
    const { store } = history(base);
    expect(
      store.read("SELECT count(*) AS n FROM transactions WHERE is_internal_transfer = 1"),
    ).toEqual([{ n: 2 }]);
  });
});
