// Budget bridges (S31a spec 4.4, 4.6; events.md 8.3): merchant rules, import batches, transactions
// (claims, cash expenses, leg deletes) and the cushion. Each rule maps a synthetic Python change to
// catalog events through the planner (parseEvent + DET self-check). Synthetic rows only.
import { ibanKey } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { GenesisCounters } from "../../genesis/report.js";
import { readPythonSource, scopeProfiles } from "../../genesis/source.js";
import { NO_FILES } from "../../genesis/testing/phase1.js";
import { PythonRows } from "../../genesis/testing/pythonRows.js";
import { pythonDb } from "../../genesis/testing/pythonSchema.js";
import type { SqlValue } from "../../sql/driver.js";
import { plan } from "../plan.js";
import { type CurrentRows, VaultMapping } from "../resolve.js";
import { DET, idsOf, outboxRow, T0, T1, testPorts, vaultInput } from "../testing/rows.js";
import { cushionEvents } from "./budget.js";

/** A checksum-valid synthetic IBAN: the account's phase-1 gid is DET(iban), as in `sync_ids`. */
const IBAN = "PL61109010140000071219812874";
const ACCOUNT_GID = DET("accounts", ["iban", ibanKey(IBAN)]);
const BATCH_GID = "01JQ0000000000000000000020";
const TXN_GID = "01JQ0000000000000000000021";
const CASH_GID = "01JQ0000000000000000000022";
const HASH = "a".repeat(40);

const ids = idsOf({
  "accounts|3": ACCOUNT_GID,
  "category_rules|4": DET("category_rules", ["syn shop"]),
  "import_batches|6": BATCH_GID,
  "transactions|20": TXN_GID,
  "transactions|30": CASH_GID,
});

type Row = Parameters<typeof outboxRow>[0];

function run(rows: Row[], current?: () => CurrentRows) {
  return plan({
    rows: rows.map((p) => outboxRow(p)),
    vaults: [vaultInput(ids, current)],
    ports: testPorts(),
  });
}

function shipped(rows: Row[], current?: () => CurrentRows) {
  const r = run(rows, current);
  if (!r.ok) throw new Error(`blocked: ${r.reason}`);
  const events = r.plan.batches.flatMap((b) => b.events);
  return { plan: r.plan, events, types: events.map((e) => e.t) };
}

const blocked = (rows: Row[], current?: () => CurrentRows) => {
  const r = run(rows, current);
  return r.ok ? "ok" : r.reason;
};

const rulePost = (o: Record<string, unknown> = {}) => ({
  id: 4,
  merchant_key: "syn shop",
  category: "jedzenie",
  source: "manual",
  locked: 1,
  created_at: T0,
  ...o,
});

const batchPost = (o: Record<string, unknown> = {}) => ({
  id: 6,
  source: "CSV",
  bank: "mbank",
  account_id: 3,
  filename: "syn.csv",
  started_at: T0,
  finished_at: null,
  num_seen: 0,
  num_inserted: 0,
  num_duplicates: 0,
  notes: null,
  ...o,
});

const txnPost = (o: Record<string, unknown> = {}) => ({
  id: 20,
  account_id: 3,
  booking_date: "2026-03-01",
  value_date: null,
  amount: "-12.50",
  currency: "PLN",
  counterparty_name: "syn shop",
  counterparty_iban: null,
  description: "syn purchase",
  reference: null,
  bank_transaction_id: null,
  source: "CSV",
  dedup_hash: HASH,
  occurrence: 0,
  transfer_group_id: null,
  is_internal_transfer: 0,
  category: "jedzenie",
  category_source: "manual_txn",
  raw: { k: "v" },
  import_batch_id: null,
  created_at: T0,
  ...o,
});

const cashPost = (o: Record<string, unknown> = {}) =>
  txnPost({
    id: 30,
    counterparty_name: "syn cash",
    description: "syn cash",
    reference: "syn cash",
    source: "MANUAL",
    dedup_hash: `cashexp:${"b".repeat(32)}`,
    raw: { cash_expense: true },
    ...o,
  });

/** Outbox values as SQLite stores them (JSON columns as text). */
function sqlRow(values: Readonly<Record<string, unknown>>): Record<string, SqlValue> {
  const out: Record<string, SqlValue> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === "string" || typeof v === "number" || v === null) out[k] = v;
    else out[k] = JSON.stringify(v);
  }
  return out;
}

/** The live Python rows (phase-1 input): the IBAN account 3 and the given transactions. */
function live(txns: readonly Record<string, unknown>[]): () => CurrentRows {
  const driver = pythonDb();
  const r = new PythonRows(driver);
  r.insert("profiles");
  r.insert("accounts", { id: 3, iban: IBAN });
  for (const t of txns) r.insert("transactions", sqlRow(t));
  const counters = new GenesisCounters();
  const source = readPythonSource(driver, NO_FILES, counters);
  const [scope] = scopeProfiles(source, counters);
  if (scope === undefined) throw new Error("no scope");
  const global = { instruments: source.invInstruments, aliases: source.invInstrumentAliases };
  return () => ({ scope, global });
}

describe("category rules", () => {
  it("an insert is categoryRule.set on DET(merchant key); an edit is the whole value", () => {
    const ins = shipped([
      { table: "category_rules", localId: "4", fields: rulePost(), post: rulePost() },
    ]);
    expect(ins.events.map((e) => [e.t, e.g])).toEqual([
      ["categoryRule.set", DET("category_rules", ["syn shop"])],
    ]);
    const upd = shipped([
      {
        table: "category_rules",
        localId: "4",
        op: "update",
        fields: { category: "transport" },
        prev: { category: "jedzenie" },
        post: rulePost({ category: "transport" }),
      },
    ]);
    expect(upd.events.map((e) => [e.t, e.d.category, e.d.source, e.d.locked])).toEqual([
      ["categoryRule.set", "transport", "manual", true],
    ]);
  });

  it("blocks a merchant key change, a source outside the catalog and a delete", () => {
    const update = (fields: Record<string, unknown>, prev: Record<string, unknown>) =>
      blocked([
        {
          table: "category_rules",
          localId: "4",
          op: "update",
          fields,
          prev,
          post: rulePost(fields),
        },
      ]);
    expect(update({ merchant_key: "other" }, { merchant_key: "syn shop" })).toBe(
      "immutable:category_rules:merchant_key",
    );
    expect(update({ source: "keyword" }, { source: "manual" })).toBe(
      "bad-enum:category_rules:source",
    );
    expect(
      blocked([{ table: "category_rules", localId: "4", op: "delete", fields: rulePost() }]),
    ).toBe("no-delete-event:category_rules");
  });
});

describe("import batches", () => {
  it("insert + the end-of-import update in one transaction is one importBatch.recorded", () => {
    const done = batchPost({ finished_at: T1, num_seen: 5, num_inserted: 4, num_duplicates: 1 });
    const { events } = shipped([
      {
        table: "import_batches",
        localId: "6",
        gid: BATCH_GID,
        fields: batchPost(),
        post: batchPost(),
      },
      {
        table: "import_batches",
        localId: "6",
        op: "update",
        gid: BATCH_GID,
        fields: { finished_at: T1, num_seen: 5, num_inserted: 4, num_duplicates: 1 },
        prev: { finished_at: null, num_seen: 0, num_inserted: 0, num_duplicates: 0 },
        post: done,
      },
    ]);
    expect(events.map((e) => [e.t, e.g, e.d.account, e.d.numSeen, e.d.finishedAt])).toEqual([
      ["importBatch.recorded", BATCH_GID, ACCOUNT_GID, 5, "2026-03-02T11:30:00.250000Z"],
    ]);
  });

  it("an update in a later transaction blocks (a batch is recorded once)", () => {
    expect(
      blocked([
        {
          table: "import_batches",
          localId: "6",
          op: "update",
          gid: BATCH_GID,
          fields: { notes: "late" },
          prev: { notes: null },
          post: batchPost({ notes: "late" }),
        },
      ]),
    ).toBe("immutable:import_batches:notes");
  });
});

describe("transactions", () => {
  it("a bank row insert with a manual claim is txn.imported + txn.categorySet on DET(row key)", () => {
    const post = txnPost();
    const { events, plan: p } = shipped(
      [{ table: "transactions", localId: "20", fields: post, post }],
      live([post]),
    );
    expect(events.map((e) => e.t)).toEqual(["txn.imported", "txn.categorySet"]);
    const gid = events[0]?.g;
    expect(events[0]?.d).toMatchObject({ account: ACCOUNT_GID, source: "csv", raw: { k: "v" } });
    expect(events[1]).toMatchObject({ g: gid, d: { category: "jedzenie", source: "manual_txn" } });
    expect(p.batches[0]?.gids).toEqual([{ table: "transactions", localId: "20", gid }]);
  });

  it("a claim change is txn.categorySet; a change away from a claim is txn.categoryCleared", () => {
    const set = txnPost({ category: "transport", category_source: "llm_full" });
    const a = shipped(
      [
        {
          table: "transactions",
          localId: "20",
          op: "update",
          fields: { category: "transport", category_source: "llm_full" },
          prev: { category: "jedzenie", category_source: "manual_txn" },
          post: set,
        },
      ],
      live([set]),
    );
    expect(a.events.map((e) => [e.t, e.g, e.d.category, e.d.source])).toEqual([
      ["txn.categorySet", TXN_GID, "transport", "llm_full"],
    ]);
    const cleared = txnPost({ category: "zakupy", category_source: "rule" });
    const b = shipped(
      [
        {
          table: "transactions",
          localId: "20",
          op: "update",
          fields: { category: "zakupy", category_source: "rule" },
          prev: { category: "jedzenie", category_source: "manual_txn" },
          post: cleared,
        },
      ],
      live([cleared]),
    );
    expect(b.events.map((e) => [e.t, e.g])).toEqual([["txn.categoryCleared", TXN_GID]]);
    expect(Object.keys(b.events[0]?.d ?? {})).toEqual(["stamps"]);
  });

  it("blocks a change of import data", () => {
    const post = txnPost({ description: "rewritten" });
    expect(
      blocked(
        [
          {
            table: "transactions",
            localId: "20",
            op: "update",
            fields: { description: "rewritten" },
            prev: { description: "syn purchase" },
            post,
          },
        ],
        live([post]),
      ),
    ).toBe("immutable:transactions:description");
  });

  it("a cash expense: added with its minted gid, recategorized as a claim, deleted", () => {
    const added = shipped([
      { table: "transactions", localId: "30", gid: CASH_GID, fields: cashPost(), post: cashPost() },
    ]);
    expect(added.events.map((e) => [e.t, e.g, e.d.title, e.d.category])).toEqual([
      ["txn.cashExpenseAdded", CASH_GID, "syn cash", "jedzenie"],
    ]);
    const recat = shipped([
      {
        table: "transactions",
        localId: "30",
        op: "update",
        gid: CASH_GID,
        fields: { category: "transport", category_source: "manual_txn" },
        prev: { category: "jedzenie" },
        post: cashPost({ category: "transport" }),
      },
    ]);
    expect(recat.events.map((e) => [e.t, e.g, e.d.category, e.d.source])).toEqual([
      ["txn.categorySet", CASH_GID, "transport", "manual_txn"],
    ]);
    const { is_internal_transfer: _a, transfer_group_id: _b, ...last } = cashPost();
    const del = shipped([
      { table: "transactions", localId: "30", op: "delete", gid: CASH_GID, fields: last },
    ]);
    expect(del.events.map((e) => [e.t, e.g, e.d])).toEqual([["txn.deleted", CASH_GID, {}]]);
  });

  it("a bank row delete has no event", () => {
    expect(
      blocked([{ table: "transactions", localId: "20", op: "delete", fields: txnPost() }]),
    ).toBe("no-delete-event:transactions");
  });

  it("leg_delete clears the claim on the leg gid DET(transactions)[cashleg, @source]", () => {
    const { events, plan: p } = shipped([
      { table: "transactions", localId: "21", op: "leg_delete", fields: { cash_leg_of: 20 } },
    ]);
    expect(events.map((e) => [e.t, e.g, e.d])).toEqual([
      ["txn.categoryCleared", DET("transactions", ["cashleg", TXN_GID]), {}],
    ]);
    expect(p.batches[0]?.carries[0]).toEqual([]);
    expect(
      blocked([
        { table: "transactions", localId: "21", op: "leg_delete", fields: { cash_leg_of: 99 } },
      ]),
    ).toBe("unresolved:transactions");
  });
});

describe("cushion", () => {
  it("cushionEvents is the genesis budgetSettings.cushionSet with the vault's account gids", () => {
    const vm = new VaultMapping(vaultInput(ids), testPorts());
    const events = cushionEvents(
      {
        enabled: true,
        currency: "PLN",
        targetAmount: "5000.00",
        targetMonths: null,
        accountIds: [3],
        monthlyMax: null,
      },
      vm.ctx,
    );
    expect(events).toEqual([
      {
        type: "budgetSettings.cushionSet",
        gid: DET("budget_settings", ["cushion"]),
        data: {
          enabled: true,
          currency: "PLN",
          targetAmount: "5000.00",
          targetMonths: null,
          accounts: [ACCOUNT_GID],
          monthlyMax: null,
        },
      },
    ]);
  });
});
