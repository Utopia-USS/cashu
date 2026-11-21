// The budget.categories deriver (S24c, D-24.1) on hand-made synthetic histories, one behaviour per
// test, every event applied alone (the incremental path), with the derived oracle and the domain
// recompute after each event. The random search is categories.property(.exhaustive).test.ts.
import { describe, expect, it } from "vitest";
import { formatHlc } from "../../events/v1/hlc-format.js";
import type { Store } from "../../materialize.js";
import { expectCategoriesRecomputed } from "../../testing/categories-oracle.js";
import type { RefEvent } from "../../testing/scenario-bridge.js";
import { Names, toEnvelopes } from "../../testing/scenario-bridge.js";
import { complete, syntheticDet } from "../../testing/scenarios.js";
import { openTestStore } from "../../testing/store.js";

function nrb(bban24: string): string {
  const check = 98n - (BigInt(`${bban24}252100`) % 97n);
  return `${check.toString().padStart(2, "0")}${bban24}`;
}
const N1 = nrb("114000000000000000000001");
const N2 = nrb("114000000000000000000002");

type Spec = [type: string, gid: string, data: Record<string, unknown>, wall?: number];

/** Apply `specs` one event at a time; check both oracles after each; return the store and names. */
function history(specs: readonly Spec[]): { store: Store; names: Names } {
  let wall = 100;
  const events: RefEvent[] = specs.map(([type, gid, data, at], i) => {
    wall += 1;
    const w = at ?? wall;
    return complete({
      eid: `01JF${String(i + 1).padStart(22, "0")}`,
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
    expectCategoriesRecomputed(store);
  }
  return { store, names };
}

const A1: Spec = ["account.opened", "A1", { iban: N1, keys: [`iban:${N1}`] }];
const imp = (h: string, data: Record<string, unknown>, wall?: number): Spec => [
  "txn.imported",
  `T-${h}`,
  { account: "A1", dedupHash: h, occurrence: 0, amount: "-23.99", ...data },
  wall,
];
const monthly = (h: string, month: string, name = "ZXQ DEMO", wall?: number) =>
  imp(h, { bookingDate: `2026-${month}-04`, counterpartyName: name }, wall);

function cat(store: Store, names: Names, row: string): [string | null, string | null] {
  const r = store.read<{ category: string | null; category_source: string | null }>(
    "SELECT category, category_source FROM transactions WHERE gid = ?",
    names.gid(row),
  )[0];
  return [r?.category ?? null, r?.category_source ?? null];
}

describe("budget.categories: precedence (events.md 8.3)", () => {
  it("a merchant rule re-derives every row of its payee; locked beats an llm claim, manual_txn beats all", () => {
    const { store, names } = history([
      A1,
      imp("h1", { counterpartyName: "ZXQ DEMO", bookingDate: "2026-01-02" }),
      imp("h2", { counterpartyName: "ZXQ DEMO", bookingDate: "2026-03-20" }),
      ["txn.categorySet", "T-h1", { category: "groceries", source: "llm_full" }],
      [
        "categoryRule.set",
        "R1",
        { merchantKey: "ZXQ DEMO", category: "travel", source: "llm", locked: false },
      ],
    ]);
    expect(cat(store, names, "T-h1")).toEqual(["groceries", "llm_full"]);
    expect(cat(store, names, "T-h2")).toEqual(["travel", "llm"]);
    const more = history([
      A1,
      imp("h1", { counterpartyName: "ZXQ DEMO", bookingDate: "2026-01-02" }),
      imp("h2", { counterpartyName: "ZXQ DEMO", bookingDate: "2026-03-20" }),
      ["txn.categorySet", "T-h1", { category: "groceries", source: "llm_full" }],
      [
        "categoryRule.set",
        "R1",
        { merchantKey: "ZXQ DEMO", category: "travel", source: "manual", locked: true },
      ],
      ["txn.categorySet", "T-h2", { category: "gifts", source: "manual_txn" }],
    ]);
    expect(cat(more.store, more.names, "T-h1")).toEqual(["travel", "manual"]);
    expect(cat(more.store, more.names, "T-h2")).toEqual(["gifts", "manual_txn"]);
  });

  it("a row on a cash account keeps its claim, else no category (D-09.4)", () => {
    const { store, names } = history([
      A1,
      imp("h1", { counterpartyName: "ZXQ DEMO" }),
      imp("h2", { counterpartyName: "ZXQ DEMO" }),
      ["txn.categorySet", "T-h2", { category: "gifts", source: "manual_txn" }],
      ["account.typeSet", "A1", { type: "cash" }],
    ]);
    expect(cat(store, names, "T-h1")).toEqual([null, null]);
    expect(cat(store, names, "T-h2")).toEqual(["gifts", "manual_txn"]);
  });

  it("a loan payment pattern makes outflows `loans` (keyword); a later pattern re-derives", () => {
    const { store, names } = history([
      A1,
      imp("h1", { reference: "RATA 1/120 TEST" }),
      ["account.opened", "L", { externalId: "kl", keys: ["ext:mbank:kl"], type: "loan" }],
      [
        "loan.termsSet",
        "LOAN",
        {
          account: "L",
          principal: "100.00",
          annualRate: "6.5",
          termMonths: 120,
          startDate: "2026-01-10",
          originationDate: null,
        },
      ],
      [
        "loan.paymentMatchingSet",
        "LOAN",
        { account: "L", paymentIban: null, paymentText: "rata 1/120" },
      ],
    ]);
    expect(cat(store, names, "T-h1")).toEqual(["loans", "keyword"]);
  });
});

describe("budget.categories: own IBANs (D-08.1)", () => {
  it("an account opened later makes rows to its IBAN transfers, a raw invalid IBAN too", () => {
    const raw = "99114000000000000000000009";
    const { store, names } = history([
      A1,
      imp("h1", { counterpartyName: "ZXQ DEMO", counterpartyIban: N2 }),
      imp("h2", { counterpartyName: "ZXQ DEMO", counterpartyIban: raw }),
      ["account.opened", "A2", { iban: N2, keys: [`iban:${N2}`] }],
      ["account.opened", "A3", { iban: raw, externalId: "k3", keys: ["ext:mbank:k3"] }],
    ]);
    expect(cat(store, names, "T-h1")).toEqual(["transfer", "transfer"]);
    expect(cat(store, names, "T-h2")).toEqual(["transfer", "transfer"]);
  });
});

describe("budget.categories: subscription payees (D-24.6)", () => {
  it("the third monthly row flags the payee; every row of it follows", () => {
    const two = history([A1, monthly("h1", "06"), monthly("h2", "07")]);
    expect(cat(two.store, two.names, "T-h1")).toEqual(["other", "default"]);
    const three = history([A1, monthly("h1", "06"), monthly("h2", "07"), monthly("h3", "08")]);
    for (const h of ["T-h1", "T-h2", "T-h3"]) {
      expect(cat(three.store, three.names, h)).toEqual(["subscriptions", "subscription"]);
    }
  });

  it("an earlier import of a row key with another payee re-folds it: the old payee loses its flag", () => {
    const { store, names } = history([
      A1,
      monthly("h1", "06"),
      monthly("h2", "07"),
      monthly("h3", "08"),
      // sorts before the h3 import above: the row key's first applied member now names another payee
      monthly("h3", "08", "INNY QXZ", 1),
    ]);
    expect(cat(store, names, "T-h1")).toEqual(["other", "default"]);
    expect(cat(store, names, "T-h3")).toEqual(["other", "default"]);
  });

  it("a decided claim outside the subscription categories still counts; a claim to a non-subscription one removes the row", () => {
    const { store, names } = history([
      A1,
      monthly("h1", "06"),
      monthly("h2", "07"),
      monthly("h3", "08"),
      ["txn.categorySet", "T-h3", { category: "housing", source: "manual_txn" }],
    ]);
    expect(cat(store, names, "T-h1")).toEqual(["other", "default"]);
    expect(cat(store, names, "T-h3")).toEqual(["housing", "manual_txn"]);
  });
});
