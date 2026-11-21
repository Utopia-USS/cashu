// The month aggregates deriver (`budget.months`) on the edits the phone makes most: a single row's
// category, and a merchant rule that moves every row of a payee across months, accounts and
// currencies (also into a structural category, which takes the rows out of the flow sums and so
// changes their day groups). After each apply the tables equal the recompute from the rows, and the
// incremental derivation (row memory included) equals `deriveAll`. Synthetic data only.
import { sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { detGid } from "../../gid.js";
import type { Store } from "../../materialize.js";
import { expectMonthsRecomputed, monthTables } from "../../testing/months-oracle.js";
import { EventFactory, openTestStore, TEST_SALT, type TestEnvelope } from "../../testing/store.js";

const ACCOUNTS = [
  { gid: detGid(TEST_SALT, "accounts", ["ext", "mbank", "months-1"]), currency: "PLN" },
  { gid: detGid(TEST_SALT, "accounts", ["ext", "mbank", "months-2"]), currency: "PLN" },
  { gid: detGid(TEST_SALT, "accounts", ["ext", "erste", "months-3"]), currency: "EUR" },
] as const;

function vault() {
  const f = new EventFactory("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "01JM");
  let wall = 0;
  const next = () => {
    wall += 1;
    return wall;
  };
  const events: TestEnvelope[] = ACCOUNTS.map((a, i) =>
    f.make(
      "account.opened",
      a.gid,
      {
        bank: i === 2 ? "erste" : "mbank",
        externalId: `months-${i + 1}`,
        iban: null,
        currency: a.currency,
        type: "checking",
        name: `Synthetic ${i + 1}`,
        keys: [`ext:${i === 2 ? "erste" : "mbank"}:months-${i + 1}`],
      },
      { wall: next() },
    ),
  );
  const imports: TestEnvelope[] = [];
  for (let n = 0; n < 240; n++) {
    const a = ACCOUNTS[n % 3] as (typeof ACCOUNTS)[number];
    const hash = bytesToHex(sha1(utf8ToBytes(`months-txn-${n}`)));
    const month = String(1 + (n % 6)).padStart(2, "0");
    const day = String(1 + (n % 27)).padStart(2, "0");
    // every seventh row an inflow; amounts with one and two decimals (exact exponents)
    const amount = n % 7 === 0 ? `${100 + n}.5` : `-${(1 + (n % 37) * 1.25).toFixed(2)}`;
    const e = f.make(
      "txn.imported",
      detGid(TEST_SALT, "transactions", [a.gid, hash, "0"]),
      {
        account: a.gid,
        batch: null,
        bookingDate: `2026-${month}-${day}`,
        valueDate: null,
        amount,
        currency: a.currency,
        counterpartyName: `SYNTHETIC SHOP ${n % 5}`,
        counterpartyIban: null,
        description: "synthetic purchase",
        reference: null,
        bankTransactionId: null,
        source: "csv",
        dedupHash: hash,
        occurrence: 0,
        raw: {},
      },
      { wall: next() },
    );
    imports.push(e);
    events.push(e);
  }
  const store = openTestStore();
  store.applyEnvelopes(events);
  return { store, f, next, imports };
}

/** The tables equal the recompute from the rows, and re-deriving everything changes nothing. */
function expectConsistent(store: Store): void {
  expectMonthsRecomputed(store);
  const incremental = monthTables(store);
  expect(store.rederive().touchedTables).toEqual(new Set());
  expect(monthTables(store)).toEqual(incremental);
}

const payeeKey = (store: Store, name: string): string =>
  store.read<{ k: string }>(
    "SELECT merchant_key AS k FROM transactions WHERE counterparty_name = ? LIMIT 1",
    name,
  )[0]?.k as string;

describe("budget.months on category edits", () => {
  it("a single row's category moves it between month groups, its day groups stay", () => {
    const { store, f, next, imports } = vault();
    try {
      expectConsistent(store);
      const days = () => store.read("SELECT * FROM fold_month_day ORDER BY 1, 2, 3, 4");
      const before = days();
      for (const [k, category] of ["fuel", "home", "fuel"].entries()) {
        store.applyEnvelopes([
          f.make(
            "txn.categorySet",
            (imports[10 + k] as TestEnvelope).gid,
            { category, source: "manual_txn" },
            { wall: next() },
          ),
        ]);
        expectConsistent(store);
      }
      expect(days()).toEqual(before);
      // the same row back and forth, and a decision on an inflow
      store.applyEnvelopes([
        f.make(
          "txn.categorySet",
          (imports[10] as TestEnvelope).gid,
          { category: "groceries", source: "manual_txn" },
          { wall: next() },
        ),
        f.make(
          "txn.categorySet",
          (imports[14] as TestEnvelope).gid,
          { category: "salary", source: "manual_txn" },
          { wall: next() },
        ),
      ]);
      expectConsistent(store);
      // two rows of one account and month swap groups in one apply: both groups are recomputed, and
      // the row that joined a recomputed group is not added on top
      store.applyEnvelopes([
        f.make(
          "txn.categorySet",
          (imports[16] as TestEnvelope).gid,
          { category: "fuel", source: "manual_txn" },
          { wall: next() },
        ),
      ]);
      store.applyEnvelopes([
        f.make(
          "txn.categorySet",
          (imports[22] as TestEnvelope).gid,
          { category: "fuel", source: "manual_txn" },
          { wall: next() },
        ),
        f.make(
          "txn.categorySet",
          (imports[16] as TestEnvelope).gid,
          { category: "home", source: "manual_txn" },
          { wall: next() },
        ),
      ]);
      expectConsistent(store);
    } finally {
      store.close();
    }
  });

  it("a merchant rule moves every row of a payee, also out of the flow sums and back", () => {
    const { store, f, next } = vault();
    try {
      const payee = payeeKey(store, "SYNTHETIC SHOP 3");
      const rule = detGid(TEST_SALT, "category_rules", ["SYNTHETIC SHOP 3"]);
      const moved = () =>
        store.read<{ category: string | null; n: number }>(
          "SELECT category, count(*) AS n FROM transactions WHERE merchant_key = ? GROUP BY 1",
          payee,
        );
      for (const category of ["health", "transfer", "dining", "health"]) {
        store.applyEnvelopes([
          f.make(
            "categoryRule.set",
            rule,
            { merchantKey: payee, category, source: "manual", locked: true },
            { wall: next() },
          ),
        ]);
        // 48 rows over 6 months and 3 accounts (2 currencies)
        expect(moved()).toEqual([{ category, n: 48 }]);
        expectConsistent(store);
      }
    } finally {
      store.close();
    }
  });
});
