// Random synthetic budget scripts for internal transfers (S24b, D-24.1 / D-24.2): imports of
// opposite amounts over a small universe of accounts, dates a few days apart and counterparty IBANs
// (own valid, own raw, foreign, the cash pool's, none), so pairs form, compete and dissolve; accounts
// learning or merging IBANs and being removed; manual cash withdrawals (mirror legs), cash expenses
// and their deletes on a pool that may carry an IBAN. The properties: two delivery orders give one
// view hash (order independence); after every batch the incremental derivation equals `deriveAll`
// (derived oracle); the transfer columns equal the domain recompute and the categories theirs; a
// rebuild keeps the hash (rebuild == incremental). Used by `budget/derive/transfers.property.test.ts`
// (fast tier) and its exhaustive twin. Synthetic data only.
import fc from "fast-check";
import { expect } from "vitest";
import { viewHash } from "../snapshot.js";
import { expectCategoriesRecomputed } from "./categories-oracle.js";
import { deliver, nrb, type Step, scriptOf } from "./category-script.js";
import { expectTransfersRecomputed } from "./transfers-oracle.js";

const N1 = nrb("114000000000000000000001");
const N2 = nrb("114000000000000000000002");
const N3 = nrb("114000000000000000000004");
/** A raw IBAN failing the checksum (own by D-08.1, never an identity key). */
const RAW = "99114000000000000000000003";
const FOREIGN = "DE89370400440532013000";

const pick = <T>(xs: readonly T[]) => fc.constantFrom(...xs);
const ACCOUNTS = ["A1", "A2", "A3", "pool:PLN"] as const;
const BANK = ["A1", "A2", "A3"] as const;
const HASHES = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;
const DATES = ["2026-10-01", "2026-10-02", "2026-10-04", "2026-10-05", "2026-10-08"] as const;
const AMOUNTS = ["-40.00", "40.00", "40.0", "-40.00", "-12.34", "12.34", "0.00"] as const;
const IBANS = [null, N1, N2, RAW, FOREIGN, N3] as const;
const EXPENSES = ["X1", "X2"] as const;

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.constant({ type: "account.opened", gid: "A1", data: { iban: N1, keys: [`iban:${N1}`] } }),
  fc.constant({
    type: "account.opened",
    gid: "A2",
    data: { iban: RAW, externalId: "k2", keys: ["ext:mbank:k2"] },
  }),
  fc.constant({
    type: "account.opened",
    gid: "A3",
    data: { externalId: "k3", keys: ["ext:mbank:k3"] },
  }),
  // the pool, with or without an IBAN (first applied open wins)
  pick([null, N3]).map((iban) => ({
    type: "account.opened",
    gid: "pool:PLN",
    data: {
      bank: "manual",
      name: "Gotówka",
      iban,
      externalId: "cash:PLN",
      type: "cash",
      keys: ["ext:manual:cash:PLN"],
    },
  })),
  // A3 learns A1's IBAN (the two merge) or its own
  pick([N1, N2]).map((n) => ({
    type: "account.identified",
    gid: "A3",
    data: { iban: n, keys: [`iban:${n}`] },
  })),
  fc.record({ gid: pick(BANK), removed: fc.boolean() }).map(({ gid, removed }) => ({
    type: removed ? "account.removed" : "account.restored",
    gid,
    data: {},
  })),
  fc
    .record({
      account: pick(BANK),
      h: pick(HASHES),
      date: pick(DATES),
      amount: pick(AMOUNTS),
      iban: pick(IBANS),
    })
    .map(({ account, h, date, amount, iban }) => ({
      type: "txn.imported",
      gid: `T-${account}-${h}-0`,
      data: {
        account,
        dedupHash: h,
        occurrence: 0,
        bookingDate: date,
        amount,
        counterpartyName: "PRZELEW",
        counterpartyIban: iban,
      },
    })),
  fc
    .record({ account: pick(BANK), h: pick(HASHES), withdrawal: fc.boolean() })
    .map(({ account, h, withdrawal }) =>
      withdrawal
        ? {
            type: "txn.categorySet",
            gid: `T-${account}-${h}-0`,
            data: { category: "cash_withdrawal", source: "manual_txn" },
          }
        : { type: "txn.categoryCleared", gid: `T-${account}-${h}-0`, data: {} },
    ),
  fc.record({ x: pick(EXPENSES), date: pick(DATES) }).map(({ x, date }) => ({
    type: "txn.cashExpenseAdded",
    gid: x,
    data: {
      account: "pool:PLN",
      bookingDate: date,
      amount: "-40.00",
      title: "Kawa",
      category: "food",
    },
  })),
  pick(EXPENSES).map((gid) => ({ type: "txn.deleted", gid, data: {} })),
);

/** One own transfer: the outflow names the other account's IBAN, the inflow a day later. */
const transfer: fc.Arbitrary<Step[]> = fc
  .record({
    from: pick(ACCOUNTS.slice(0, 3)),
    to: pick(["A1", "A2"] as const),
    h: pick(HASHES),
    date: fc.nat(2),
  })
  .map(({ from, to, h, date }) => {
    const iban = to === "A1" ? N1 : RAW;
    const imp = (account: string, amount: string, d: string, cp: string | null): Step => ({
      type: "txn.imported",
      gid: `T-${account}-${h}-0`,
      data: {
        account,
        dedupHash: h,
        occurrence: 0,
        bookingDate: d,
        amount,
        counterpartyName: "PRZELEW WLASNY",
        counterpartyIban: cp,
      },
    });
    return [
      imp(from, "-40.00", DATES[date] ?? "2026-10-01", iban),
      imp(to, "40.00", DATES[date + 1] ?? "2026-10-02", null),
    ];
  });

/**
 * A cash withdrawal mirrored on a pool that carries an IBAN, plus an outflow naming that IBAN: the
 * leg (an inflow on the pool) can pair, which Python never produces but the store must keep exact.
 */
const withdrawal: fc.Arbitrary<Step[]> = fc
  .record({
    from: pick(BANK),
    other: pick(BANK),
    h: pick(HASHES),
    g: pick(HASHES),
    date: fc.nat(3),
  })
  .map(({ from, other, h, g, date }) => {
    const d = DATES[date] ?? "2026-10-01";
    const imp = (account: string, hash: string, cp: string | null): Step => ({
      type: "txn.imported",
      gid: `T-${account}-${hash}-0`,
      data: {
        account,
        dedupHash: hash,
        occurrence: 0,
        bookingDate: d,
        amount: "-40.00",
        counterpartyName: "WYPLATA",
        counterpartyIban: cp,
      },
    });
    return [
      {
        type: "account.opened",
        gid: "pool:PLN",
        data: {
          bank: "manual",
          name: "Gotówka",
          iban: N3,
          externalId: "cash:PLN",
          type: "cash",
          keys: ["ext:manual:cash:PLN"],
        },
      },
      imp(from, h, null),
      {
        type: "txn.categorySet",
        gid: `T-${from}-${h}-0`,
        data: { category: "cash_withdrawal", source: "manual_txn" },
      },
      imp(other, g, N3),
    ];
  });

const script = scriptOf(step, fc.oneof(transfer, withdrawal));

export const transfersProperty = fc.property(
  script,
  fc.integer({ min: 1, max: 1_000_000 }),
  (events, seed) => {
    const a = deliver(events, seed, (s) => {
      expect(s.rederive().touchedTables).toEqual(new Set());
    });
    const b = deliver(events, seed + 1);
    const h = viewHash(a).hash;
    expect(viewHash(b).hash).toBe(h);
    expectTransfersRecomputed(a);
    expectCategoriesRecomputed(a);
    a.rebuild();
    expect(viewHash(a).hash).toBe(h);
  },
);
