// Performance smoke on the spike's workload shape (spike-result.md: 60k unique transactions + 2k
// duplicate re-imports, 1,900 merchant rule edits over 400 merchants, 300 decisions; 3 accounts).
// Synthetic data. Budgets are generous ceilings for CI machines; the measured numbers on the owner's
// Mac are recorded in the S23 checkpoint (spike reference: full rebuild 0.32 s).
import { sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { detGid } from "./gid.js";
import { viewHash } from "./snapshot.js";
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
  const f = new EventFactory("aaaaaaaaaaaaaaaa", "01JC");
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

/** CPU time of this worker since `t0` (ms): wall time is meaningless on a loaded machine. */
function ms(t0: { user: number; system: number }): number {
  const d = process.cpuUsage(t0);
  return Math.round((d.user + d.system) / 1000);
}

const now = () => process.cpuUsage();

describe("perf smoke: 64k events", () => {
  it("bulk apply, rebuild, incremental, late re-fold, identity re-fold", {
    timeout: 300_000,
  }, () => {
    const { events, f, next } = workload();
    const store = openTestStore();
    let t0 = now();
    for (let i = 0; i < events.length; i += 1000) store.applyEnvelopes(events.slice(i, i + 1000));
    const bulk = ms(t0);
    expect(store.read("SELECT COUNT(*) AS n FROM transactions")).toEqual([{ n: 60_000 }]);
    expect(store.read("SELECT COUNT(*) AS n FROM category_rules")).toEqual([{ n: 400 }]);
    const hash = viewHash(store).hash;

    t0 = now();
    store.rebuild();
    const rebuild = ms(t0);
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
    const edits10 = ms(t0);

    // a late claim from another device that sorts before thousands of applied events
    const late = new EventFactory("bbbbbbbbbbbbbbbb", "01JH");
    t0 = now();
    store.applyEnvelopes([
      late.make(
        "txn.categorySet",
        (events[5000] as TestEnvelope).gid,
        { category: "home", source: "manual_txn" },
        { wall: 5001 },
      ),
    ]);
    const lateRefold = ms(t0);

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
    const identityRefold = ms(t0);

    const report = { events: events.length, bulk, rebuild, edits10, lateRefold, identityRefold };
    console.log(`S23 perf (CPU ms): ${JSON.stringify(report)}`);
    // Ceilings, not targets (CI machines, a loaded dev Mac): see the checkpoint for measured numbers.
    expect(bulk).toBeLessThan(30_000);
    expect(rebuild).toBeLessThan(10_000);
    expect(lateRefold).toBeLessThan(1_000);
  });
});
