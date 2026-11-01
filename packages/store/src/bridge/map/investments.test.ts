// Investments bridges (S31a spec 4.4; events.md 8.5, 8.6): each rule maps a synthetic Python change
// to the catalog events, validated by the planner (parseEvent + the DET self-check). Synthetic rows
// only.
import { describe, expect, it } from "vitest";
import type { GidResolver } from "../../genesis/ids.js";
import { vaultIds } from "../../genesis/ids.js";
import { GenesisCounters } from "../../genesis/report.js";
import type { InvInstrumentAliasRow, InvInstrumentRow } from "../../genesis/rows.js";
import type { ProfileScope } from "../../genesis/source.js";
import { TABLES } from "../../genesis/tables.js";
import { plan } from "../plan.js";
import type { CurrentRows } from "../resolve.js";
import {
  DET,
  idsOf,
  outboxRow,
  SALT,
  T0,
  T1,
  testPorts,
  VAULT,
  vaultInput,
} from "../testing/rows.js";

const INSTRUMENT_GID = "01JQ0000000000000000000011";
const OTHER_INSTRUMENT_GID = "01JQ0000000000000000000012";
const BATCH_GID = "01JQ0000000000000000000013";
const MANUAL_GID = "01JQ0000000000000000000014";
const ACCOUNT_IBAN = "PL61109010140000071219812874";

const instrumentRow = (o: Partial<InvInstrumentRow> = {}): InvInstrumentRow => ({
  id: 3,
  name: "syn fund",
  currency: "PLN",
  assetClass: "etf",
  symbol: "SYN",
  isin: null,
  mic: null,
  region: null,
  sector: null,
  tags: [],
  needsClassification: false,
  valuationMode: "market",
  status: "active",
  createdAt: T0,
  updatedAt: T0,
  ...o,
});

const alias9: InvInstrumentAliasRow = {
  id: 9,
  instrumentId: 3,
  namespace: "yahoo",
  value: "SYN.WA",
  guessed: true,
  createdAt: T1,
};

/** The live rows of profile 1: one IBAN account, instrument 3 referenced by a valuation. */
function current(extra: Partial<ProfileScope> = {}): CurrentRows {
  const empty = Object.fromEntries(Object.keys(TABLES).map((k) => [k, []]));
  const scope = {
    ...empty,
    profile: {
      id: 1,
      slug: "syn",
      name: "Syn",
      baseCurrency: "PLN",
      mcpPrivacy: "strict",
      createdAt: T0,
    },
    accounts: [
      {
        id: 1,
        profileId: 1,
        bank: "mbank",
        name: "syn broker",
        iban: ACCOUNT_IBAN,
        externalId: null,
        currency: "PLN",
        type: "brokerage",
        active: true,
        createdAt: T0,
        removedAt: null,
      },
    ],
    invManualValuations: [
      {
        id: 1,
        profileId: 1,
        instrumentId: 3,
        asOf: "2026-02-01",
        unitValue: "10",
        currency: "PLN",
        note: null,
        createdAt: T0,
      },
    ],
    ...extra,
  } as unknown as ProfileScope;
  return { scope, global: { instruments: [instrumentRow()], aliases: [alias9] } };
}

const ACCOUNT_GID =
  vaultIds(
    current().scope,
    current().global,
    { vault: VAULT, salt: SALT },
    0,
    new GenesisCounters(),
  ).accounts.get(1)?.gid ?? "";

const ids = idsOf({
  "accounts|1": ACCOUNT_GID,
  "inv_instruments|3": INSTRUMENT_GID,
  "inv_instruments|4": OTHER_INSTRUMENT_GID,
  "inv_import_batches|2": BATCH_GID,
  "inv_account_settings|1": DET("inv_account_settings", [ACCOUNT_GID]),
  "inv_position_snapshots|5": DET("inv_position_snapshots", [
    ACCOUNT_GID,
    INSTRUMENT_GID,
    "2026-03-01",
  ]),
  "inv_manual_valuations|1": DET("inv_manual_valuations", [INSTRUMENT_GID, "2026-02-01"]),
  "inv_profile_instruments|6": DET("inv_profile_instruments", [INSTRUMENT_GID]),
  "inv_instrument_aliases|9": DET("inv_instrument_aliases", ["yahoo", "SYN.WA"]),
});

type Row = Parameters<typeof outboxRow>[0];

function run(rows: Row[], syncIds: GidResolver = ids, live: () => CurrentRows = () => current()) {
  return plan({
    rows: rows.map((p) => outboxRow(p)),
    vaults: [vaultInput(syncIds, live)],
    ports: testPorts(),
  });
}

function shipped(rows: Row[], live?: () => CurrentRows) {
  const r = run(rows, ids, live);
  if (!r.ok) throw new Error(`blocked: ${r.reason}`);
  const events = r.plan.batches.flatMap((b) => b.events);
  const gids = r.plan.batches.flatMap((b) => b.gids);
  return { plan: r.plan, events, gids, types: events.map((e) => e.t) };
}

const blockOf = (rows: Row[]) => {
  const r = run(rows);
  return r.ok ? "ok" : r.reason;
};

describe("account settings, imports, transactions", () => {
  const settings = (o: Record<string, unknown> = {}) => ({
    account_id: 1,
    wrapper: "ike",
    importer: null,
    mapping_yaml: null,
    created_at: T0,
    updated_at: T1,
    ...o,
  });

  it("a settings insert is invAccount.settingsSet under the DET gid of its account", () => {
    const { events, gids } = shipped([
      { table: "inv_account_settings", localId: "1", fields: settings(), post: settings() },
    ]);
    const gid = DET("inv_account_settings", [ACCOUNT_GID]);
    expect(events.map((e) => [e.t, e.g, e.d.account, e.d.wrapper])).toEqual([
      ["invAccount.settingsSet", gid, ACCOUNT_GID, "ike"],
    ]);
    expect(gids).toEqual([{ table: "inv_account_settings", localId: "1", gid }]);
  });

  it("a settings update ships the whole value again", () => {
    const { events } = shipped([
      {
        table: "inv_account_settings",
        localId: "1",
        op: "update",
        fields: { importer: "xtb" },
        prev: { importer: null },
        post: settings({ importer: "xtb" }),
      },
    ]);
    expect(events.map((e) => [e.t, e.d.wrapper, e.d.importer, e.d.mappingYaml])).toEqual([
      ["invAccount.settingsSet", "ike", "xtb", null],
    ]);
  });

  const batch = {
    id: 2,
    account_id: 1,
    importer: "xtb",
    broker: "xtb",
    file_name: "syn.csv",
    file_sha256: "a".repeat(64),
    archive_path: null,
    txn_count: 1,
    duplicate_count: 0,
    position_count: 0,
    rename_count: 0,
    status_change_count: 0,
    instrument_count: 0,
    correction_count: 0,
    warnings: [],
    created_at: T0,
  };

  it("an import batch insert is invImport.recorded; an update of it blocks", () => {
    const { events } = shipped([
      { table: "inv_import_batches", localId: "2", gid: BATCH_GID, fields: batch, post: batch },
    ]);
    expect(events.map((e) => [e.t, e.g, e.d.txnCount])).toEqual([
      ["invImport.recorded", BATCH_GID, 1],
    ]);
    const update = {
      table: "inv_import_batches",
      localId: "2",
      op: "update" as const,
      fields: { txn_count: 2 },
      prev: { txn_count: 1 },
      post: { ...batch, txn_count: 2 },
    };
    expect(blockOf([update])).toBe("immutable:inv_import_batches:txn_count");
  });

  const txn = (o: Record<string, unknown> = {}) => ({
    id: 8,
    account_id: 1,
    type: "deposit",
    trade_date: "2026-03-01",
    settle_date: null,
    instrument_id: null,
    quantity: null,
    price: null,
    currency: "PLN",
    gross_amount: "100",
    fee: "0",
    tax: "0",
    cash_amount: "100",
    cash_currency: "PLN",
    fx_rate: null,
    split_ratio: null,
    note: null,
    source: "manual",
    import_batch_id: null,
    external_ref: null,
    dedup_hash: "syn-hash",
    created_at: T0,
    ...o,
  });
  const liveTxn = (o: Record<string, unknown> = {}) => ({
    id: 8,
    accountId: 1,
    type: "deposit",
    tradeDate: "2026-03-01",
    settleDate: null,
    instrumentId: null,
    quantity: null,
    price: null,
    currency: "PLN",
    grossAmount: "100",
    fee: "0",
    tax: "0",
    cashAmount: "100",
    cashCurrency: "PLN",
    fxRate: null,
    splitRatio: null,
    note: null,
    source: "manual",
    importBatchId: null,
    externalRef: null,
    dedupHash: "syn-hash",
    createdAt: T0,
    ...o,
  });

  it("a manual transaction keeps Python's minted gid and hashes as manual:<gid>", () => {
    const live = () => current({ invTransactions: [liveTxn()] } as Partial<ProfileScope>);
    const { events, gids } = shipped(
      [{ table: "inv_transactions", localId: "8", gid: MANUAL_GID, fields: txn(), post: txn() }],
      live,
    );
    expect(events.map((e) => [e.t, e.g, e.d.dedupHash, e.d.account])).toEqual([
      ["invTxn.imported", MANUAL_GID, `manual:${MANUAL_GID}`, ACCOUNT_GID],
    ]);
    expect(gids).toEqual([]);
  });

  it("an imported transaction takes the phase-1 dedupHashV2 and its DET gid (sent with the ack)", () => {
    const o = { source: "import" };
    const live = () => current({ invTransactions: [liveTxn(o)] } as Partial<ProfileScope>);
    const { events, gids } = shipped(
      [{ table: "inv_transactions", localId: "8", fields: txn(o), post: txn(o) }],
      live,
    );
    const hash = String(events[0]?.d.dedupHash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const gid = DET("inv_transactions", [ACCOUNT_GID, hash]);
    expect(events.map((e) => [e.t, e.g])).toEqual([["invTxn.imported", gid]]);
    expect(gids).toEqual([{ table: "inv_transactions", localId: "8", gid }]);
  });

  it("a transaction update or delete blocks (no catalog event)", () => {
    const base = { table: "inv_transactions", localId: "8", gid: MANUAL_GID };
    expect(
      blockOf([
        {
          ...base,
          op: "update",
          fields: { note: "x" },
          prev: { note: null },
          post: txn({ note: "x" }),
        },
      ]),
    ).toBe("immutable:inv_transactions:note");
    expect(blockOf([{ ...base, op: "delete", fields: txn() }])).toBe(
      "no-delete-event:inv_transactions",
    );
  });
});

describe("positions, renames, valuations", () => {
  const position = {
    id: 5,
    account_id: 1,
    instrument_id: 3,
    as_of: "2026-03-01",
    quantity: "2",
    currency: "PLN",
    avg_price: null,
    market_value: "20",
    import_batch_id: 2,
    created_at: T0,
  };

  it("a position snapshot insert is DET(account, instrument, as_of); a re-import update blocks", () => {
    const { events } = shipped([
      { table: "inv_position_snapshots", localId: "5", fields: position, post: position },
    ]);
    const gid = DET("inv_position_snapshots", [ACCOUNT_GID, INSTRUMENT_GID, "2026-03-01"]);
    expect(events.map((e) => [e.t, e.g, e.d.batch])).toEqual([
      ["position.snapshotImported", gid, BATCH_GID],
    ]);
    const reimport = {
      table: "inv_position_snapshots",
      localId: "5",
      op: "update" as const,
      fields: { quantity: "3" },
      prev: { quantity: "2" },
      post: { ...position, quantity: "3" },
    };
    expect(blockOf([reimport])).toBe("immutable:inv_position_snapshots:quantity");
  });

  it("a rename insert is instrumentRename.recorded", () => {
    const rename = {
      id: 4,
      date: "2026-03-01",
      old_instrument_id: 3,
      new_instrument_id: 4,
      note: null,
      import_batch_id: null,
      created_at: T0,
    };
    const { events } = shipped([
      { table: "inv_instrument_renames", localId: "4", fields: rename, post: rename },
    ]);
    const gid = DET("inv_instrument_renames", ["2026-03-01", INSTRUMENT_GID, OTHER_INSTRUMENT_GID]);
    expect(events.map((e) => [e.t, e.g, e.d.old, e.d.new])).toEqual([
      ["instrumentRename.recorded", gid, INSTRUMENT_GID, OTHER_INSTRUMENT_GID],
    ]);
  });

  const valuation = (o: Record<string, unknown> = {}) => ({
    id: 1,
    instrument_id: 3,
    as_of: "2026-02-01",
    unit_value: "10",
    currency: "PLN",
    note: null,
    created_at: T0,
    ...o,
  });

  it("a valuation upsert ships valuation.set whole; moving its key blocks", () => {
    const { events } = shipped([
      {
        table: "inv_manual_valuations",
        localId: "1",
        op: "update",
        fields: { unit_value: "11" },
        prev: { unit_value: "10" },
        post: valuation({ unit_value: "11" }),
      },
    ]);
    expect(events.map((e) => [e.t, e.d.unitValue, e.d.asOf, e.d.currency, e.d.note])).toEqual([
      ["valuation.set", "11", "2026-02-01", "PLN", null],
    ]);
    const moved = {
      table: "inv_manual_valuations",
      localId: "1",
      op: "update" as const,
      fields: { as_of: "2026-02-02" },
      prev: { as_of: "2026-02-01" },
      post: valuation({ as_of: "2026-02-02" }),
    };
    expect(blockOf([moved])).toBe("immutable:inv_manual_valuations:as_of");
  });
});

describe("shared instruments and aliases", () => {
  const instrumentPost = (o: Record<string, unknown> = {}) => ({
    id: 3,
    name: "syn fund",
    currency: "PLN",
    asset_class: "etf",
    symbol: "SYN",
    isin: null,
    mic: null,
    region: null,
    sector: null,
    tags: [],
    needs_classification: 0,
    valuation_mode: "market",
    status: "active",
    created_at: T0,
    updated_at: T1,
    ...o,
  });

  it("an instrument update is instrument.updated with the changed fields only", () => {
    const { events } = shipped([
      {
        table: "inv_instruments",
        localId: "3",
        profileId: null,
        op: "update",
        fields: { name: "syn fund 2", tags: ["a"] },
        prev: { name: "syn fund", tags: [] },
        post: instrumentPost({ name: "syn fund 2", tags: ["a"] }),
      },
    ]);
    expect(events.map((e) => [e.t, e.g])).toEqual([["instrument.updated", INSTRUMENT_GID]]);
    expect(events[0]?.d).toMatchObject({ name: "syn fund 2", tags: ["a"] });
    expect(Object.keys(events[0]?.d ?? {}).sort()).toEqual(["name", "stamps", "tags"]);
  });

  it("an instrument insert is left to the closure snapshot (no vault holds it yet)", () => {
    const r = run([
      {
        table: "inv_instruments",
        localId: "12",
        profileId: null,
        fields: instrumentPost({ id: 12 }),
        post: instrumentPost({ id: 12 }),
      },
    ]);
    expect(r.ok && r.plan.counts.sharedUnheld).toBe(1);
    expect(r.ok && r.plan.batches.flatMap((b) => b.events)).toEqual([]);
  });

  it("an owner merge is instrument.merged {source, target}; an unmapped source blocks", () => {
    const merge = {
      table: "inv_instruments",
      localId: "4",
      profileId: null,
      op: "merge" as const,
      fields: { source_id: 4, target_id: 3 },
      key: { source: "4", target: "3" },
    };
    const { events } = shipped([merge]);
    expect(events.map((e) => [e.t, e.g, e.d.source, e.d.target, e.d.reason])).toEqual([
      ["instrument.merged", OTHER_INSTRUMENT_GID, OTHER_INSTRUMENT_GID, INSTRUMENT_GID, "owner"],
    ]);
    // Python dropped the source mapping at emit time and the source row is gone from the live rows.
    const r = plan({
      rows: [outboxRow({ ...merge, key: { source: "40", target: "3" } })],
      vaults: [vaultInput(ids, () => current())],
      ports: testPorts(),
    });
    expect(r).toMatchObject({ ok: false, reason: "unresolved:inv_instruments" });
  });

  const aliasPost = (o: Record<string, unknown> = {}) => ({
    id: 9,
    instrument_id: 3,
    namespace: "yahoo",
    value: "SYN.WA",
    guessed: 1,
    created_at: T1,
    ...o,
  });

  it("an alias insert of a held instrument is instrument.aliasAdded under DET(namespace, value)", () => {
    const fresh = idsOf({ "inv_instruments|3": INSTRUMENT_GID, "accounts|1": ACCOUNT_GID });
    const r = run(
      [
        {
          table: "inv_instrument_aliases",
          localId: "9",
          profileId: null,
          fields: aliasPost(),
          post: aliasPost(),
        },
      ],
      fresh,
    );
    if (!r.ok) throw new Error(r.reason);
    const events = r.plan.batches.flatMap((b) => b.events);
    const gid = DET("inv_instrument_aliases", ["yahoo", "SYN.WA"]);
    expect(events.map((e) => [e.t, e.g, e.d.instrument, e.d.guessed])).toEqual([
      ["instrument.aliasAdded", gid, INSTRUMENT_GID, true],
    ]);
    expect(r.plan.batches[0]?.gids).toEqual([
      { table: "inv_instrument_aliases", localId: "9", gid },
    ]);
  });

  it("confirming a guessed alias is a claim with guessed false; un-confirming blocks", () => {
    const confirm = {
      table: "inv_instrument_aliases",
      localId: "9",
      profileId: null,
      op: "update" as const,
      fields: { guessed: 0 },
      prev: { guessed: 1 },
      post: aliasPost({ guessed: 0 }),
    };
    const { events } = shipped([confirm]);
    expect(events.map((e) => [e.t, e.d.guessed])).toEqual([["instrument.aliasAdded", false]]);
    const guess = { ...confirm, fields: { guessed: 1 }, prev: { guessed: 0 }, post: aliasPost() };
    expect(blockOf([guess])).toBe("immutable:inv_instrument_aliases:guessed");
  });
});

describe("profile instrument overrides", () => {
  const override = (o: Record<string, unknown> = {}) => ({
    id: 6,
    instrument_id: 3,
    name: null,
    asset_class: null,
    tags: null,
    region: null,
    sector: null,
    valuation_mode: null,
    status: null,
    needs_classification: null,
    plan: null,
    plan_at: null,
    plan_reason: null,
    segment: null,
    segment_by: null,
    created_at: T0,
    updated_at: T1,
    ...o,
  });
  const update = (fields: Record<string, unknown>, prev: Record<string, unknown>, post = {}) => ({
    table: "inv_profile_instruments",
    localId: "6",
    op: "update" as const,
    fields,
    prev,
    post: override({ ...fields, ...post }),
  });

  it("an insert with a plan is the genesis snapshot: set, then planSet", () => {
    const post = override({ plan: "buy", plan_at: T1, plan_reason: "r" });
    const { events } = shipped([
      { table: "inv_profile_instruments", localId: "6", fields: post, post },
    ]);
    const gid = DET("inv_profile_instruments", [INSTRUMENT_GID]);
    expect(events.map((e) => [e.t, e.g])).toEqual([
      ["instrumentOverride.set", gid],
      ["instrumentOverride.planSet", gid],
    ]);
  });

  it("a classify edit is instrumentOverride.set with the changed fields only", () => {
    const { events } = shipped([update({ tags: ["x"], needs_classification: 0 }, { tags: null })]);
    expect(events.map((e) => [e.t, e.d.instrument, e.d.tags, e.d.needsClassification])).toEqual([
      ["instrumentOverride.set", INSTRUMENT_GID, ["x"], false],
    ]);
    expect(Object.keys(events[0]?.d ?? {}).sort()).toEqual([
      "instrument",
      "needsClassification",
      "stamps",
      "tags",
    ]);
  });

  it("a plan set and a plan clear are planSet (the clear with nulls)", () => {
    const set = shipped([
      update({ plan: "buy", plan_reason: "r" }, { plan: null, plan_reason: null }, { plan_at: T1 }),
    ]);
    expect(set.events.map((e) => [e.t, e.d.plan, e.d.reason])).toEqual([
      ["instrumentOverride.planSet", "buy", "r"],
    ]);
    const clear = shipped([
      update({ plan: null, plan_reason: null }, { plan: "buy", plan_reason: "r" }),
    ]);
    expect(clear.events.map((e) => [e.t, e.d.plan, e.d.reason])).toEqual([
      ["instrumentOverride.planSet", null, null],
    ]);
  });

  it("a segment set is segmentSet; a clear keeps the agent setter of an agent segment", () => {
    const set = shipped([
      update({ segment: "tech", segment_by: "agent" }, { segment: null, segment_by: null }),
    ]);
    expect(set.events.map((e) => [e.t, e.d.segment, e.d.by])).toEqual([
      ["instrumentOverride.segmentSet", "tech", "agent"],
    ]);
    const clear = shipped([
      update({ segment: null, segment_by: null }, { segment: "tech", segment_by: "agent" }),
    ]);
    expect(clear.events.map((e) => [e.t, e.d.segment, e.d.by])).toEqual([
      ["instrumentOverride.segmentSet", null, "agent"],
    ]);
    const owner = shipped([
      update({ segment: null, segment_by: null }, { segment: "tech", segment_by: "owner" }),
    ]);
    expect(owner.events.map((e) => e.d.by)).toEqual(["owner"]);
  });

  it("moving an override to another instrument blocks", () => {
    expect(blockOf([update({ instrument_id: 4 }, { instrument_id: 3 })])).toBe(
      "immutable:inv_profile_instruments:instrument_id",
    );
  });
});
