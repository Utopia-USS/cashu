import { describe, expect, it } from "vitest";
import type { EventType } from "./events/v1/catalog.js";
import { detPartsOf } from "./events/v1/det-parts.js";
import { VALID_SAMPLES } from "./events/v1/test-fixtures.js";
import { detGidFor } from "./gid.js";
import { builtinModules } from "./modules.js";
import { exportSnapshot, importSnapshot, viewHash } from "./snapshot.js";
import {
  EventFactory,
  memoryDriver,
  openTestStore,
  TEST_SALT,
  TEST_VAULT,
  type TestEnvelope,
  testUlid,
} from "./testing/store.js";

const ACC = "70cc61c8-79b5-80ae-b8cc-fdca7caef49e";
const H1 = "451a4e645c5442bf030c14db4e9674a3592a8486";

function account(f: EventFactory, gid = ACC) {
  return f.make("account.opened", gid, {
    bank: "mbank",
    externalId: null,
    iban: null,
    currency: "PLN",
    type: "checking",
    name: "Konto testowe",
    keys: [],
  });
}

function txn(f: EventFactory, gid: string, hash = H1, occurrence = 0, account = ACC) {
  return f.make("txn.imported", gid, {
    account,
    batch: null,
    bookingDate: "2026-01-15",
    valueDate: null,
    amount: "-12.50",
    currency: "PLN",
    counterpartyName: "Sklep Testowy",
    counterpartyIban: null,
    description: "zakup testowy",
    reference: null,
    bankTransactionId: null,
    source: "csv",
    dedupHash: hash,
    occurrence,
    raw: {},
  });
}

describe("store basics", () => {
  it("folds an account and its transactions and reports touched tables", () => {
    const store = openTestStore();
    const f = new EventFactory();
    const r1 = store.applyEnvelopes([account(f)]);
    expect(r1.applied).toBe(1);
    expect([...r1.touchedTables].sort()).toEqual(["accounts"]);
    const t = "0b7c2348-a233-87ef-9f1b-4b5bd5161ee0";
    const r2 = store.applyEnvelopes([txn(f, t)]);
    expect([...r2.touchedTables]).toEqual(["transactions"]);
    const rows = store.read<{ gid: string; account_id: number; amount: string }>(
      "SELECT gid, account_id, amount FROM transactions",
    );
    expect(rows).toEqual([{ gid: t, account_id: expect.any(Number), amount: "-12.50" }]);
    const r3 = store.applyEnvelopes([
      f.make("txn.categorySet", t, { category: "groceries", source: "manual_txn" }),
    ]);
    expect([...r3.touchedTables]).toEqual(["transactions"]);
    expect(store.read("SELECT category, category_source FROM transactions")).toEqual([
      { category: "groceries", category_source: "manual_txn" },
    ]);
    const before = viewHash(store).hash;
    store.rebuild();
    expect(viewHash(store).hash).toBe(before);
  });

  it("opens on an empty database, and a reopened store reports only the tables an apply changed", () => {
    const driver = memoryDriver();
    const f = new EventFactory();
    expect([...openTestStore({ driver }).applyEnvelopes([account(f)]).touchedTables]).toEqual([
      "accounts",
    ]);
    const reopened = openTestStore({ driver });
    const r = reopened.applyEnvelopes([account(f, "a1bb665d-9bf1-81e3-916c-f49d32db099a")]);
    expect([...r.touchedTables]).toEqual(["accounts"]); // no identity conflict changed
    reopened.reset();
    expect([...openTestStore({ driver }).applyEnvelopes([account(f)]).touchedTables]).toEqual([
      "accounts",
    ]);
  });

  it("is idempotent by eid and reports a conflicting body", () => {
    const store = openTestStore();
    const f = new EventFactory();
    const e = account(f);
    store.applyEnvelopes([e]);
    const again = store.applyEnvelopes([e, { ...e }]);
    expect(again.duplicates).toBe(2);
    expect(again.touchedTables.size).toBe(0);
    const forged = store.applyEnvelopes([{ ...e, data: { ...e.data, name: "Inna" } }]);
    expect(forged.conflicts).toEqual([e.eid]);
    expect(store.read("SELECT name FROM accounts")).toEqual([{ name: "Konto testowe" }]);
  });
});

describe("touched tables and subscriptions", () => {
  const INST = "fc9daa13-f073-8a72-8cd0-c1345436bc05";
  const W = "d0a95ad2-2211-8a30-b04b-809c6be84b30";
  const SIG = "01JC0ZB5C6D7E8F9G0H1J2K3M4";
  const DEC = "01JC0ZB5C6D7E8F9G0H1J2K3M5";

  it("reports exactly the public tables an apply wrote, and notifies matching subscribers", () => {
    const store = openTestStore();
    const f = new EventFactory();
    const seen: string[][] = [];
    const off = store.subscribe(["inv_signals"], (t) => seen.push([...t].sort()));
    const v0 = store.version(["inv_signals"]);

    const w = store.applyEnvelopes([
      f.make("watchlist.added", W, { instrument: INST, source: "user" }),
    ]);
    expect([...w.touchedTables]).toEqual(["watchlist_items"]);
    expect(seen).toEqual([]);

    const opened = f.make("signal.opened", SIG, {
      ruleId: "dd",
      kind: "drawdown",
      dedupKey: `dd|i:${INST}`,
      severity: "info",
      polarity: "negative",
      message: "m",
      instrument: INST,
      account: null,
      payload: {},
      run: null,
    });
    expect([...store.applyEnvelopes([opened]).touchedTables].sort()).toEqual([
      "inv_signal_aliases",
      "inv_signals",
    ]);
    const decision = f.make("decision.recorded", DEC, {
      signals: [SIG],
      instrument: INST,
      account: null,
      action: "held",
      quantity: null,
      price: null,
      currency: null,
      reason: null,
    });
    expect([...store.applyEnvelopes([decision]).touchedTables].sort()).toEqual([
      "inv_decision_signals",
      "inv_decisions",
      "inv_signals",
    ]);
    expect(seen).toEqual([
      ["inv_signal_aliases", "inv_signals"],
      ["inv_decision_signals", "inv_decisions", "inv_signals"],
    ]);
    expect(store.version(["inv_signals"])).toBeGreaterThan(v0);

    // a duplicate touches nothing and notifies nobody
    expect(store.applyEnvelopes([decision]).touchedTables.size).toBe(0);
    expect(seen).toHaveLength(2);
    off();
    store.applyEnvelopes([f.make("signal.snoozed", SIG, { until: "2026-11-30T00:00:00.000Z" })]);
    expect(seen).toHaveLength(2);
  });

  it("a late event that re-folds a partition still reports only that materializer's tables", () => {
    const store = openTestStore();
    const late = new EventFactory("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "01JB");
    const f = new EventFactory();
    store.applyEnvelopes([account(f), txn(f, "0b7c2348-a233-87ef-9f1b-4b5bd5161ee0")]);
    // sorts before everything applied (wall 0, other device): partition re-fold of the transaction
    const r = store.applyEnvelopes([
      late.make(
        "txn.categorySet",
        "0b7c2348-a233-87ef-9f1b-4b5bd5161ee0",
        { category: "fuel", source: "manual_txn" },
        { wall: 0 },
      ),
    ]);
    // It sorts before its import, so it is a no-op in the fold; the re-fold rewrote the partition's
    // rows, and a rewrite reports its tables (a superset is safe for invalidation, never a miss).
    expect([...r.touchedTables]).toEqual(["transactions"]);
    expect(store.read("SELECT category FROM transactions")).toEqual([{ category: null }]);
    const r2 = store.applyEnvelopes([
      late.make(
        "txn.categorySet",
        "0b7c2348-a233-87ef-9f1b-4b5bd5161ee0",
        { category: "fuel", source: "manual_txn" },
        { wall: 50 },
      ),
    ]);
    expect([...r2.touchedTables]).toEqual(["transactions"]);
  });

  it("names the view tables a query reads", () => {
    const store = openTestStore();
    expect(
      [
        ...store.tablesRead(
          "SELECT t.amount FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.removed_at IS NULL",
        ),
      ].sort(),
    ).toEqual(["accounts", "transactions"]);
    expect(store.unfoldedTypes()).not.toContain("balance.recorded");
    expect(store.unfoldedTypes()).not.toContain("txn.imported");
  });
});

describe("invalid-gid parking (events.md 7.10)", () => {
  const det = detGidFor(TEST_SALT);
  const WRONG = "e912848f-6071-8821-89fb-56c500920eb6"; // a valid gid of another row key

  it("parks a txn.imported whose gid is not DET of its payload; not an upgrade signal", () => {
    const store = openTestStore();
    const f = new EventFactory();
    store.applyEnvelopes([account(f)]);
    const r = store.applyEnvelopes([txn(f, WRONG)]);
    expect(r).toMatchObject({ applied: 0, parked: 1, needsUpgrade: false });
    expect(store.needsUpgrade()).toBe(false);
    expect(store.read("SELECT type, v, reason, count FROM unknown_events")).toEqual([
      { type: "txn.imported", v: 1, reason: "invalid-gid", count: 1 },
    ]);
    expect(store.read("SELECT gid FROM transactions")).toEqual([]);
  });

  it("parks a balance.recorded with a wrong gid although no materializer folds balances yet", () => {
    const store = openTestStore();
    const f = new EventFactory();
    const data = {
      account: ACC,
      date: "2026-01-31",
      source: "csv",
      amount: "1.00",
      currency: "PLN",
    };
    const r = store.applyEnvelopes([
      f.make("balance.recorded", WRONG.replace("e912", "e913"), data),
      f.make("balance.recorded", det("balances", [ACC, "2026-01-31", "csv"]), data),
    ]);
    expect(r).toMatchObject({ applied: 1, parked: 1, needsUpgrade: false });
  });

  it("keeps an invalid-gid event parked after a rebuild that re-decodes the log", () => {
    const store = openTestStore();
    const f = new EventFactory();
    store.applyEnvelopes([account(f), txn(f, WRONG)]);
    const before = viewHash(store).hash;
    store.rebuild({ redecode: true });
    expect(viewHash(store).hash).toBe(before);
    expect(store.read("SELECT state, reason FROM event_log WHERE type = 'txn.imported'")).toEqual([
      { state: "parked", reason: "invalid-gid" },
    ]);
    expect(store.read("SELECT gid FROM transactions")).toEqual([]);
  });

  it("does not park genesis-shaped or outbox-shaped events whose gid is DET of their parts", () => {
    // Every payload-derived DET type as genesis (S26: origin genesis, explicit stamps) and as the
    // Python outbox (S30: origin bridge) would write it: gid = DET(table)[detPartsOf(payload)].
    const store = openTestStore();
    const f = new EventFactory();
    const envs: TestEnvelope[] = [];
    for (const type of Object.keys(VALID_SAMPLES) as EventType[]) {
      const p = detPartsOf(type, VALID_SAMPLES[type]);
      if (p === undefined) continue;
      const gid = det(p.table, p.parts);
      for (const origin of ["genesis", "bridge"] as const) {
        const stamps =
          origin === "genesis" ? { stamps: { created_at: "2026-01-01T00:00:00.000000Z" } } : {};
        envs.push({ ...f.make(type, gid, { ...VALID_SAMPLES[type], ...stamps }), origin });
      }
    }
    // genesis specifics (gid.md 7): a legacy budget hash, an instrument without a creation alias
    // (genesis gid), one created under its stored alias, and a manual investment entry (ULID).
    const legacy = `legacy:${H1}`;
    envs.push({
      ...txn(f, det("transactions", [ACC, legacy, "0"]), legacy),
      origin: "genesis",
    });
    const created = VALID_SAMPLES["instrument.created"];
    envs.push({
      ...f.make("instrument.created", det("genesis", ["inv_instruments", "7"]), {
        ...created,
        creationAlias: null,
      }),
      origin: "genesis",
    });
    envs.push({
      ...f.make("instrument.created", det("inv_instruments", ["yahoo:TST.WA"]), {
        ...created,
        creationAlias: "yahoo:TST.WA",
      }),
      origin: "genesis",
    });
    const manual = testUlid("01JE", 1);
    envs.push({
      ...f.make("invTxn.imported", manual, {
        ...VALID_SAMPLES["invTxn.imported"],
        source: "manual",
        dedupHash: `manual:${manual}`,
      }),
      origin: "bridge",
    });
    const r = store.applyEnvelopes(envs);
    expect(r.rejected).toEqual([]);
    expect(r.parked).toBe(0);
    expect(store.read("SELECT COUNT(*) AS n FROM unknown_events")).toEqual([{ n: 0 }]);
  });
});

describe("snapshots", () => {
  it("exports the whole store and imports it on another device with the same view", () => {
    const store = openTestStore();
    const f = new EventFactory();
    store.applyEnvelopes([account(f), txn(f, "0b7c2348-a233-87ef-9f1b-4b5bd5161ee0")]);
    const snap = exportSnapshot(store);
    const copy = importSnapshot(
      { driver: memoryDriver(), vault: TEST_VAULT, salt: TEST_SALT, modules: builtinModules() },
      JSON.parse(JSON.stringify(snap)),
    );
    expect(viewHash(copy).hash).toBe(viewHash(store).hash);
    // the imported store keeps working: a duplicate is recognised, a new event applies
    expect(copy.applyEnvelopes([account(f, "70cc61c8-79b5-80ae-b8cc-fdca7caef49e")]).applied).toBe(
      1,
    );
  });
});
