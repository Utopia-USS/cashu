// Performance smoke on the spike's workload shape (spike-result.md: 60k unique transactions + 2k
// duplicate re-imports, 1,900 merchant rule edits over 400 merchants, 300 decisions; 3 accounts).
// Synthetic data. Budgets are generous ceilings for CI machines; measured numbers (wall and CPU, same
// run as the spike's own benchmark) are in the cashu-ts-architecture performance reference. With
// CASHU_PERF_DB=<path> the store runs on a database file with the spike's pragmas (WAL, synchronous
// NORMAL); otherwise in memory. One `S23B_PERF {...}` line reports every phase.
import { sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { detGid } from "./gid.js";
import { viewHash } from "./snapshot.js";
import { betterSqlite3Driver } from "./sql/better-sqlite3.js";
import { rng } from "./testing/random.js";
import {
  EventFactory,
  openTestStore,
  TEST_SALT,
  type TestEnvelope,
  testUlid,
} from "./testing/store.js";

const ACCOUNTS = [
  { gid: detGid(TEST_SALT, "accounts", ["ext", "mbank", "perf-1"]), currency: "PLN" },
  { gid: detGid(TEST_SALT, "accounts", ["ext", "mbank", "perf-2"]), currency: "PLN" },
  { gid: detGid(TEST_SALT, "accounts", ["ext", "erste", "perf-3"]), currency: "EUR" },
];

function workload() {
  const f = new EventFactory("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "01JC");
  const r = rng(42);
  const events: TestEnvelope[] = [];
  let wall = 0;
  const next = () => {
    wall += 1;
    return wall;
  };
  for (const [i, a] of ACCOUNTS.entries()) {
    events.push(
      f.make(
        "account.opened",
        a.gid,
        {
          bank: i === 2 ? "erste" : "mbank",
          externalId: `perf-${i + 1}`,
          iban: null,
          currency: a.currency,
          type: "checking",
          name: `Konto ${i + 1}`,
          keys: [`ext:${i === 2 ? "erste" : "mbank"}:perf-${i + 1}`],
        },
        { wall: next() },
      ),
    );
  }
  const imports: TestEnvelope[] = [];
  for (let n = 0; n < 60_000; n++) {
    const a = ACCOUNTS[n % 3] as (typeof ACCOUNTS)[number];
    const hash = bytesToHex(sha1(utf8ToBytes(`perf-txn-${n}`)));
    const day = 1 + (n % 28);
    const e = f.make(
      "txn.imported",
      detGid(TEST_SALT, "transactions", [a.gid, hash, "0"]),
      {
        account: a.gid,
        batch: null,
        bookingDate: `2024-${String(1 + (n % 12)).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
        valueDate: null,
        amount: `-${(1 + Math.floor(r() * 50000) / 100).toFixed(2)}`,
        currency: a.currency,
        counterpartyName: `SKLEP ${n % 400}`,
        counterpartyIban: null,
        description: "zakup",
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
  // 2,000 duplicate re-imports: same fact (same DET gid), new eid from an overlapping export
  for (let n = 0; n < 2_000; n++) {
    const orig = imports[Math.floor(r() * imports.length)] as TestEnvelope;
    events.push({
      ...orig,
      eid: testUlid("01JF", n + 1),
      hlc: f.make("x.y", orig.gid, {}, { wall: next() }).hlc,
    });
  }
  for (let n = 0; n < 1_900; n++) {
    const m = `SKLEP ${n % 400}`;
    events.push(
      f.make(
        "categoryRule.set",
        detGid(TEST_SALT, "category_rules", [m]),
        {
          merchantKey: m,
          category: ["groceries", "fuel", "home"][n % 3],
          source: "manual",
          locked: true,
        },
        { wall: next() },
      ),
    );
  }
  // S24 additions: 2k claims (10 % manual cash withdrawals, so legs exist), the cash pool, 300 cash
  // expenses, 30 loan events on one loan account.
  const pool = detGid(TEST_SALT, "accounts", ["ext", "manual", "cash:PLN"]);
  events.push(
    f.make(
      "account.opened",
      pool,
      {
        bank: "manual",
        externalId: "cash:PLN",
        iban: null,
        currency: "PLN",
        type: "cash",
        name: "Gotówka",
        keys: ["ext:manual:cash:PLN"],
      },
      { wall: next() },
    ),
  );
  for (let n = 0; n < 2_000; n++) {
    const t = imports[(n * 29) % imports.length] as TestEnvelope;
    events.push(
      f.make(
        "txn.categorySet",
        t.gid,
        {
          category: n % 10 === 0 ? "cash_withdrawal" : "groceries",
          source: n % 10 === 0 || n % 2 ? "manual_txn" : "llm_full",
        },
        { wall: next() },
      ),
    );
  }
  for (let n = 0; n < 300; n++) {
    events.push(
      f.make(
        "txn.cashExpenseAdded",
        testUlid("01JK", n + 1),
        {
          account: pool,
          bookingDate: "2024-06-01",
          amount: "-12.50",
          currency: "PLN",
          title: `Kawa ${n}`,
          category: "dining",
        },
        { wall: next() },
      ),
    );
  }
  const loanAccount = (ACCOUNTS[0] as (typeof ACCOUNTS)[number]).gid;
  for (let n = 0; n < 30; n++) {
    events.push(
      f.make(
        n % 2 ? "loan.paymentMatchingSet" : "loan.termsSet",
        detGid(TEST_SALT, "loans", [loanAccount]),
        n % 2
          ? { account: loanAccount, paymentIban: null, paymentText: `RATA ${n}` }
          : {
              account: loanAccount,
              principal: `${100000 + n}.00`,
              annualRate: "6.5",
              termMonths: 360,
              startDate: "2024-01-10",
              originationDate: null,
            },
        { wall: next() },
      ),
    );
  }
  for (let n = 0; n < 300; n++) {
    events.push(
      f.make(
        "decision.recorded",
        testUlid("01JG", n + 1),
        {
          signals: [],
          instrument: null,
          account: null,
          action: "held",
          quantity: null,
          price: null,
          currency: null,
          reason: null,
        },
        { wall: next() },
      ),
    );
  }
  return { events, f, next };
}

/** Wall and CPU time of this worker since `t0` (ms). On a loaded machine only CPU is comparable. */
function since(t0: { wall: number; cpu: { user: number; system: number } }) {
  const d = process.cpuUsage(t0.cpu);
  return {
    wall: Math.round(performance.now() - t0.wall),
    cpu: Math.round((d.user + d.system) / 1000),
  };
}

const now = () => ({ wall: performance.now(), cpu: process.cpuUsage() });

/** The store's database: a file with the spike's pragmas when CASHU_PERF_DB is set, else memory. */
function perfStore() {
  const path = process.env.CASHU_PERF_DB;
  if (path === undefined || path === "") return { store: openTestStore(), mode: "memory" };
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  return { store: openTestStore({ driver: betterSqlite3Driver(db) }), mode: "file" };
}

describe("perf smoke: 64k events", () => {
  it("bulk apply, rebuild, incremental, late re-fold, identity re-fold", {
    timeout: 300_000,
  }, () => {
    const { events, f, next } = workload();
    const { store, mode } = perfStore();
    let t0 = now();
    for (let i = 0; i < events.length; i += 1000) store.applyEnvelopes(events.slice(i, i + 1000));
    const bulk = since(t0);
    // 60k imports + 300 cash expenses + the legs of the 133 manual cash_withdrawal claims on the
    // two PLN accounts (the EUR account has no cash pool)
    expect(store.read("SELECT COUNT(*) AS n FROM transactions")).toEqual([{ n: 60_433 }]);
    expect(store.read("SELECT COUNT(*) AS n FROM category_rules")).toEqual([{ n: 400 }]);
    const hash = viewHash(store).hash;

    t0 = now();
    store.rebuild();
    const rebuild = since(t0);
    expect(viewHash(store).hash).toBe(hash);

    t0 = now();
    store.applyEnvelopes(
      Array.from({ length: 10 }, (_, k) =>
        f.make(
          "txn.categorySet",
          (events[3 + k] as TestEnvelope).gid,
          { category: "fuel", source: "manual_txn" },
          { wall: next() },
        ),
      ),
    );
    const edits10 = since(t0);

    // a day's events (performance.md budget: <= 100 ms): 200 imports and a few claims
    const day = Array.from({ length: 200 }, (_, n) => {
      const a = ACCOUNTS[n % 3] as (typeof ACCOUNTS)[number];
      const hash = bytesToHex(sha1(utf8ToBytes(`perf-day-${n}`)));
      return f.make(
        "txn.imported",
        detGid(TEST_SALT, "transactions", [a.gid, hash, "0"]),
        {
          account: a.gid,
          batch: null,
          bookingDate: "2025-01-02",
          valueDate: null,
          amount: "-10.00",
          currency: a.currency,
          counterpartyName: `SKLEP ${n % 400}`,
          counterpartyIban: null,
          description: "zakup",
          reference: null,
          bankTransactionId: null,
          source: "csv",
          dedupHash: hash,
          occurrence: 0,
          raw: {},
        },
        { wall: next() },
      );
    });
    const claims = day
      .slice(0, 5)
      .map((t) =>
        f.make(
          "txn.categorySet",
          t.gid,
          { category: "cash_withdrawal", source: "manual_txn" },
          { wall: next() },
        ),
      );
    t0 = now();
    store.applyEnvelopes([...day, ...claims]);
    const dayBatch = since(t0);
    expect(store.rederive().touchedTables).toEqual(new Set());

    // a late claim from another device that sorts before thousands of applied events
    const late = new EventFactory("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "01JH");
    t0 = now();
    store.applyEnvelopes([
      late.make(
        "txn.categorySet",
        (events[5000] as TestEnvelope).gid,
        { category: "home", source: "manual_txn" },
        { wall: 5001 },
      ),
    ]);
    const lateRefold = since(t0);

    // an account learns an external key held by another: identity change -> full transactions re-fold
    t0 = now();
    store.applyEnvelopes([
      f.make(
        "account.identified",
        (ACCOUNTS[1] as (typeof ACCOUNTS)[number]).gid,
        { keys: ["ext:mbank:perf-1"] },
        { wall: next() },
      ),
    ]);
    const identityRefold = since(t0);
    store.close();

    const report = {
      events: events.length,
      mode,
      bulkWall: bulk.wall,
      bulkCpu: bulk.cpu,
      rebuildWall: rebuild.wall,
      rebuildCpu: rebuild.cpu,
      edits10Wall: edits10.wall,
      dayBatchWall: dayBatch.wall,
      dayBatchCpu: dayBatch.cpu,
      lateRefoldWall: lateRefold.wall,
      identityRefoldWall: identityRefold.wall,
    };
    console.log(`S23B_PERF ${JSON.stringify(report)}`);
    // Ceilings, not targets (CI machines, a loaded dev Mac), on CPU time: measured numbers are in
    // the performance reference.
    expect(bulk.cpu).toBeLessThan(30_000);
    expect(rebuild.cpu).toBeLessThan(10_000);
    expect(lateRefold.cpu).toBeLessThan(1_000);
  });
});
