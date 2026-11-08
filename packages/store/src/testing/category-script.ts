// Random synthetic budget scripts for the effective categories (S24c, D-24.1): imports over a small
// universe of merchants, amounts, counterparty IBANs and monthly dates (so recurring groups form
// and dissolve, rows go to own accounts, members of one row key carry different content), claims,
// merchant rules (locked / llm), a loan payment pattern, account merges, a cash account, removal and
// cash expenses. The properties: two delivery orders give one view hash; after every batch the
// incremental derivation equals `deriveAll` (derived oracle); the categories equal the domain
// recompute; a rebuild keeps the hash. Used by `budget/derive/categories.property.test.ts` (fast
// tier) and its exhaustive twin. Synthetic data only.
import fc from "fast-check";
import { expect } from "vitest";
import { formatHlc } from "../events/v1/hlc-format.js";
import { complete, syntheticDet } from "../events/v1/reference/testing/scenarios.js";
import { viewHash } from "../snapshot.js";
import { expectCategoriesRecomputed } from "./categories-oracle.js";
import { chunked, shuffled } from "./random.js";
import type { RefEvent } from "./reference/fold.js";
import { Names, toEnvelopes } from "./reference-bridge.js";
import { openTestStore } from "./store.js";

const DEVICES = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] as const;

export function nrb(bban24: string): string {
  const check = 98n - (BigInt(`${bban24}252100`) % 97n);
  return `${check.toString().padStart(2, "0")}${bban24}`;
}
const N1 = nrb("114000000000000000000001");
const N2 = nrb("114000000000000000000002");
/** A raw IBAN failing the checksum (own by D-08.1, never an identity key). */
const RAW = "99114000000000000000000003";
const FOREIGN = "DE89370400440532013000";

const pick = <T>(xs: readonly T[]) => fc.constantFrom(...xs);
const ACCOUNTS = ["A1", "A2", "A3"] as const;
/** Monthly dates: four hashes in a row of one merchant and amount qualify as recurring. */
const HASHES = ["h1", "h2", "h3", "h4", "h5"] as const;
const DATE_OF: Record<string, string> = {
  h1: "2026-06-04",
  h2: "2026-07-04",
  h3: "2026-08-04",
  h4: "2026-09-04",
  h5: "2026-10-04",
};
const MERCHANTS = ["SPOTIFY DEMO", "SKLEP RYBKA", "BIEDRONKA 12", null] as const;
const RULE_KEYS = ["SPOTIFY DEMO", "SKLEP RYBKA", "BIEDRONKA 12"] as const;
const EXPENSES = ["X1", "X2"] as const;

export type Step = { type: string; gid: string; data: Record<string, unknown> };

const opened = (gid: string, data: Record<string, unknown>): Step => ({
  type: "account.opened",
  gid,
  data,
});

const step: fc.Arbitrary<Step> = fc.oneof(
  // accounts: A1 by a valid IBAN, A2 / A3 by name keys; A2 shows a raw invalid IBAN
  fc.constant(opened("A1", { iban: N1, keys: [`iban:${N1}`] })),
  fc.constant(opened("A2", { iban: RAW, externalId: "k2", keys: ["ext:mbank:k2"] })),
  fc.constant(opened("A3", { externalId: "k3", keys: ["ext:mbank:k3"] })),
  fc.constant({
    type: "account.opened",
    gid: "pool:PLN",
    data: {
      bank: "manual",
      name: "Gotówka",
      externalId: "cash:PLN",
      type: "cash",
      keys: ["ext:manual:cash:PLN"],
    },
  }),
  // A3 learns A1's IBAN (the two merge) or a second valid IBAN
  pick([N1, N2]).map((n) => ({
    type: "account.identified",
    gid: "A3",
    data: { iban: n, keys: [`iban:${n}`] },
  })),
  pick(ACCOUNTS).map((gid) => ({ type: "account.typeSet", gid, data: { type: "cash" } })),
  fc.record({ gid: pick(ACCOUNTS), removed: fc.boolean() }).map(({ gid, removed }) => ({
    type: removed ? "account.removed" : "account.restored",
    gid,
    data: {},
  })),
  // imports: content varies per event (members of one row key may disagree: first applied wins)
  fc
    .record({
      account: pick(ACCOUNTS),
      h: pick(HASHES),
      merchant: pick(MERCHANTS),
      reference: pick([null, "RATA 1/120", "PRZELEW"]),
      iban: pick([null, null, N1, N2, RAW, FOREIGN]),
      amount: pick(["-23.99", "-23.99", "-10.00", "0.00", "50.00"]),
    })
    .map(({ account, h, merchant, reference, iban, amount }) => ({
      type: "txn.imported",
      gid: `T-${account}-${h}-0`,
      data: {
        account,
        dedupHash: h,
        occurrence: 0,
        bookingDate: DATE_OF[h],
        amount,
        counterpartyName: merchant,
        counterpartyIban: iban,
        reference,
      },
    })),
  fc
    .record({
      account: pick(ACCOUNTS),
      h: pick(HASHES),
      category: pick(["groceries", "cash_withdrawal", "subscriptions", "transfer"]),
      source: pick(["manual_txn", "llm_full", "llm_fallback"]),
    })
    .map(({ account, h, category, source }) => ({
      type: "txn.categorySet",
      gid: `T-${account}-${h}-0`,
      data: { category, source },
    })),
  fc.record({ account: pick(ACCOUNTS), h: pick(HASHES) }).map(({ account, h }) => ({
    type: "txn.categoryCleared",
    gid: `T-${account}-${h}-0`,
    data: {},
  })),
  fc
    .record({
      mk: pick(RULE_KEYS),
      category: pick(["entertainment", "groceries", "housing"]),
      manual: fc.boolean(),
      locked: fc.boolean(),
    })
    .map(({ mk, category, manual, locked }) => ({
      type: "categoryRule.set",
      gid: `R-${mk}`,
      data: { merchantKey: mk, category, source: manual ? "manual" : "llm", locked },
    })),
  fc.constant({
    type: "loan.termsSet",
    gid: "LOAN-A2",
    data: {
      account: "A2",
      principal: "100.00",
      annualRate: "6.5",
      termMonths: 120,
      startDate: "2026-01-10",
      originationDate: null,
    },
  }),
  fc.record({ text: pick([null, "RATA"]), iban: pick([null, FOREIGN]) }).map(({ text, iban }) => ({
    type: "loan.paymentMatchingSet",
    gid: "LOAN-A2",
    data: { account: "A2", paymentIban: iban, paymentText: text },
  })),
  fc.record({ x: pick(EXPENSES), title: pick(["SPOTIFY DEMO", "Kawa"]) }).map(({ x, title }) => ({
    type: "txn.cashExpenseAdded",
    gid: x,
    data: {
      account: "pool:PLN",
      bookingDate: "2026-10-20",
      amount: "-23.99",
      title,
      category: "food",
    },
  })),
  pick(EXPENSES).map((gid) => ({ type: "txn.deleted", gid, data: {} })),
);

/** A monthly series of one merchant and amount on one account (a recurring group, 3 to 5 months). */
const series: fc.Arbitrary<Step[]> = fc
  .record({
    account: pick(ACCOUNTS),
    from: fc.nat(2),
    n: fc.integer({ min: 3, max: 5 }),
    merchant: pick(["SPOTIFY DEMO", "SKLEP RYBKA"]),
    reference: pick([null, "RATA 1/120"]),
  })
  .map(({ account, from, n, merchant, reference }) =>
    HASHES.slice(from, from + n).map((h) => ({
      type: "txn.imported",
      gid: `T-${account}-${h}-0`,
      data: {
        account,
        dedupHash: h,
        occurrence: 0,
        bookingDate: DATE_OF[h],
        amount: "-23.99",
        counterpartyName: merchant,
        counterpartyIban: null,
        reference,
      },
    })),
  );

/** A script with walls that mostly increase and sometimes repeat (concurrent devices). */
export const scriptOf = (step: fc.Arbitrary<Step>, series: fc.Arbitrary<Step[]>) =>
  fc
    .array(
      fc.record({
        steps: fc.oneof(
          { weight: 4, arbitrary: step.map((x) => [x]) },
          { weight: 1, arbitrary: series },
        ),
        device: fc.nat(1),
        concurrent: fc.boolean(),
      }),
      { minLength: 1, maxLength: 24 },
    )
    .map((groups) =>
      groups.flatMap(({ steps, device, concurrent }) =>
        steps.map((s) => ({ step: s, device, concurrent })),
      ),
    )
    .map((items) => {
      let wall = 0;
      return items.map(({ step: s, device, concurrent }, i): RefEvent => {
        if (!concurrent) wall += 1;
        return complete({
          eid: `01JE${String(i + 1).padStart(22, "0")}`,
          hlc: formatHlc({
            wall: 1_793_448_000_000 + wall,
            counter: i + 1,
            device: DEVICES[device] ?? DEVICES[0],
          }),
          at: new Date(1_793_448_000_000 + wall).toISOString(),
          type: s.type,
          gid: s.gid,
          data: s.data,
        });
      });
    });

const script = scriptOf(step, series);

/** Deliver in a seeded order with duplicates and random batches; `each` runs after every batch. */
export function deliver(
  events: RefEvent[],
  seed: number,
  each?: (s: ReturnType<typeof openTestStore>) => void,
) {
  const envs = toEnvelopes(events, new Names(), syntheticDet(events));
  const order = shuffled(envs, seed);
  const withDupes = [...order, ...shuffled(order, seed + 99).slice(0, 2)];
  const store = openTestStore();
  for (const b of chunked(withDupes, seed + 7, seed % 3 === 0 ? 1 : 4)) {
    store.applyEnvelopes(b);
    each?.(store);
  }
  return store;
}

export const categoriesProperty = fc.property(
  script,
  fc.integer({ min: 1, max: 1_000_000 }),
  (events, seed) => {
    const a = deliver(events, seed, (s) => {
      expect(s.rederive().touchedTables).toEqual(new Set());
    });
    const b = deliver(events, seed + 1);
    const h = viewHash(a).hash;
    expect(viewHash(b).hash).toBe(h);
    expectCategoriesRecomputed(a);
    a.rebuild();
    expect(viewHash(a).hash).toBe(h);
  },
);
