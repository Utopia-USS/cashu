/// <reference types="node" />
// S26 spec 6.1-6.3, 6.6, 4.6 and gid.md 7, 7.4, 7.6: gid.md 8 vectors through the genesis path
// (test salt 00..1f), account classification, un-parking, collisions, instrument creation aliases,
// the `ids` seed list and rows left out by a required reference. Synthetic rows only.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gidOf, phase1, TEST_VAULT } from "./testing/phase1.js";
import { PythonRows } from "./testing/pythonRows.js";
import { pythonDb } from "./testing/pythonSchema.js";

/** A valid IBAN whose iban key is 26 zeros: the gid.md 8 "account by IBAN" vector. */
const ZERO_KEY_IBAN = "AZ00000000000000000000000000";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

function db() {
  const driver = pythonDb();
  const rows = new PythonRows(driver);
  rows.insert("profiles", {});
  return { driver, rows };
}

describe("gid.md 8 vectors through the genesis path", () => {
  it("core and budget rows", () => {
    const { driver, rows } = db();
    rows.insert("profile_modules", { module_id: "budget" });
    const ibanAccount = rows.insert("accounts", { iban: ZERO_KEY_IBAN });
    const extAccount = rows.insert("accounts", { bank: "mbank", external_id: "eb:TESTUID0001" });
    const balance = rows.insert("balances", {
      account_id: ibanAccount,
      date: "2026-01-31",
      source: "CSV",
    });
    const txn = {
      account_id: ibanAccount,
      booking_date: "2026-01-15",
      amount: "-12.50",
      currency: "PLN",
      counterparty_name: "Sklep Testowy",
      description: "zakup testowy",
    };
    const t0 = rows.insert("transactions", { ...txn, dedup_hash: "a".repeat(40), occurrence: 0 });
    const t1 = rows.insert("transactions", { ...txn, dedup_hash: "a".repeat(40), occurrence: 1 });
    const leg = rows.insert("transactions", {
      dedup_hash: `cashleg:${t0}`,
      raw: JSON.stringify({ cash_leg_of: t0 }),
    });
    const rule = rows.insert("category_rules", { merchant_key: "SKLEP TESTOWY" });
    const loan = rows.insert("loans", { account_id: ibanAccount });
    const binding = rows.insert("connector_bindings", {
      account_id: extAccount,
      connector_id: "example-broker",
    });
    const topic = rows.insert("inv_topic_theses", { segment: "gold" });

    const v = phase1(driver).vaults[0];
    expect(gidOf(v, "profiles", 1)).toBe(TEST_VAULT);
    expect(gidOf(v, "profile_modules", "1|budget")).toBe("fdb0a016-38e3-8d64-8dec-88673f5cdcda");
    expect(gidOf(v, "accounts", ibanAccount)).toBe("70cc61c8-79b5-80ae-b8cc-fdca7caef49e");
    expect(gidOf(v, "accounts", extAccount)).toBe("a1bb665d-9bf1-81e3-916c-f49d32db099a");
    expect(gidOf(v, "balances", balance)).toBe("e912848f-6071-8821-89fb-56c500920eb6");
    expect(v?.budgetTxns.get(t0)?.dedupHash).toBe("451a4e645c5442bf030c14db4e9674a3592a8486");
    expect(gidOf(v, "transactions", t0)).toBe("0b7c2348-a233-87ef-9f1b-4b5bd5161ee0");
    expect(gidOf(v, "transactions", t1)).toBe("7a9a8c41-5f11-8b3c-94d7-114812fc0227");
    expect(v?.cashLegClaims.get(leg)).toBe("95c48228-d6ec-8832-83ad-15ba530cfe8f");
    expect(v?.resolver.gid("transactions", String(leg))).toBeUndefined();
    expect(gidOf(v, "category_rules", rule)).toBe("cc9078fc-ae3d-8c1d-8381-55311fb4c8b2");
    expect(gidOf(v, "loans", loan)).toBe("b3120349-b79c-869e-819b-cd2c34f608d0");
    expect(gidOf(v, "connector_bindings", binding)).toBe("6ad703ab-383d-8c73-82a5-1ee2d6742735");
    expect(gidOf(v, "inv_topic_theses", topic)).toBe("21465e71-86fc-8535-ab21-87bbe3ca85ba");
  });

  it("investments rows and a genesis gid", () => {
    const { driver, rows } = db();
    const account = rows.insert("accounts", { bank: "mbank", external_id: "eb:TESTUID0001" });
    const instrument = rows.insert("inv_instruments", {});
    const isin = rows.insert("inv_instrument_aliases", { instrument_id: instrument });
    const yahoo = rows.insert("inv_instrument_aliases", {
      instrument_id: instrument,
      namespace: "yahoo",
      value: "TEST.WA",
    });
    rows.insert("inv_instrument_aliases", {
      instrument_id: instrument,
      namespace: "testbroker",
      value: "TST",
    });
    const batch = rows.insert("inv_import_batches", { account_id: account, broker: "testbroker" });
    const v1 = sha256(
      [
        "v1",
        "content",
        account,
        "2026-02-03",
        "buy",
        instrument,
        "10",
        "12.5",
        "125",
        "-125.5",
        "0",
      ]
        .map(String)
        .join("\u001f"),
    );
    const txn = rows.insert("inv_transactions", {
      account_id: account,
      import_batch_id: batch,
      instrument_id: instrument,
      trade_date: "2026-02-03",
      type: "buy",
      quantity: "10",
      price: "12.5",
      gross_amount: "125",
      cash_amount: "-125.5",
      dedup_hash: v1,
    });
    const watch = rows.insert("watchlist_items", { instrument_id: instrument });
    const thesis = rows.insert("inv_theses", { id: 7, instrument_id: instrument });

    const { vaults, counters } = phase1(driver);
    const v = vaults[0];
    expect(gidOf(v, "inv_instruments", instrument)).toBe("fc9daa13-f073-8a72-8cd0-c1345436bc05");
    expect(v?.instruments.get(instrument)?.creationAlias).toBe("isin:XX0000000001");
    expect(gidOf(v, "inv_instrument_aliases", yahoo)).toBe("20157f67-f236-82f9-ab83-c6d176f65f27");
    expect(gidOf(v, "inv_instrument_aliases", isin)).toMatch(/^[0-9a-f-]{36}$/);
    expect(v?.invDedupHashes.get(txn)).toBe(
      "a75921e3e5f26dd7918d9b26f7237fbd4cb84d1ffd71686d37f64e6b2eba912e",
    );
    expect(gidOf(v, "inv_transactions", txn)).toBe("f4948051-edd0-8710-babe-0f15b44cc19a");
    expect(counters.get("inv_transactions", "occ_v1_match", 0)).toBe(1);
    expect(counters.get("inv_transactions", "ikey_broker", 0)).toBe(1);
    expect(gidOf(v, "watchlist_items", watch)).toBe("d0a95ad2-2211-8a30-b04b-809c6be84b30");
    expect(gidOf(v, "inv_theses", thesis)).toBe("c1e52d4d-d9a5-84e6-8d7a-c21b36691202");
  });
});

describe("accounts (spec 6.2, 6.3)", () => {
  it("classifies external ids, IBAN validity and bank keys", () => {
    const { driver, rows } = db();
    const ids = {
      none: rows.insert("accounts", {}),
      manual: rows.insert("accounts", { external_id: "manual:Gotowka" }),
      vehicle: rows.insert("accounts", { external_id: "vehicle:Auto" }),
      brokerage: rows.insert("accounts", { external_id: "brokerage:0123" }),
      importKey: rows.insert("accounts", { bank: "erste", external_id: "import:konto" }),
      cash: rows.insert("accounts", { bank: "cash", external_id: "cash:PLN" }),
      nrb: rows.insert("accounts", { iban: "38123400000000000000000001" }),
      badIban: rows.insert("accounts", { iban: "PL00123", external_id: "eb:X" }),
      badBank: rows.insert("accounts", { bank: "Bad Bank", external_id: "eb:Y" }),
    };
    const { vaults, counters } = phase1(driver);
    const a = (id: number) => vaults[0]?.accounts.get(id);
    const det = vaults[0]?.det;
    const genesis = (id: number) => det?.("genesis", ["accounts", String(id)]);
    for (const id of [ids.none, ids.manual, ids.vehicle, ids.brokerage]) {
      expect(a(id)).toEqual({ gid: genesis(id), keys: [], externalId: a(id)?.externalId ?? null });
    }
    expect(a(ids.importKey)?.keys).toEqual(["ext:erste:import:konto"]);
    expect(a(ids.importKey)?.gid).toBe(det?.("accounts", ["ext", "erste", "import:konto"]));
    expect(a(ids.cash)?.keys).toEqual(["ext:cash:cash:PLN"]);
    expect(a(ids.nrb)?.keys).toEqual(["iban:38123400000000000000000001"]);
    expect(a(ids.nrb)?.gid).toBe(det?.("accounts", ["iban", "38123400000000000000000001"]));
    expect(a(ids.badIban)?.keys).toEqual(["ext:mbank:eb:X"]);
    expect(a(ids.badIban)?.gid).toBe(det?.("accounts", ["ext", "mbank", "eb:X"]));
    expect(a(ids.badBank)?.keys).toEqual([]);
    expect(a(ids.badBank)?.gid).toBe(det?.("accounts", ["ext", "Bad Bank", "eb:Y"]));
    expect(counters.get("accounts", "iban_invalid", 0)).toBe(1);
    expect(counters.get("accounts", "bank_not_key", 0)).toBe(1);
  });

  it("un-parks the own suffix and keeps a foreign one (counted)", () => {
    const { driver, rows } = db();
    const own = rows.insert("accounts", { id: 5, external_id: "import:stare~5" });
    const foreign = rows.insert("accounts", { id: 6, external_id: "import:inne~9" });
    const { vaults, counters } = phase1(driver);
    expect(vaults[0]?.accounts.get(own)?.externalId).toBe("import:stare");
    expect(vaults[0]?.accounts.get(own)?.keys).toEqual(["ext:mbank:import:stare"]);
    expect(vaults[0]?.accounts.get(foreign)?.externalId).toBe("import:inne~9");
    expect(counters.get("accounts", "foreign_park_suffix", 0)).toBe(1);
  });

  it("keeps colliding live accounts apart: the lowest id keeps gid and keys", () => {
    const { driver, rows } = db();
    const first = rows.insert("accounts", { bank: "mbank", iban: ZERO_KEY_IBAN });
    const sameIban = rows.insert("accounts", { bank: "erste", iban: ZERO_KEY_IBAN });
    // A parked key on a live account (not what Python writes, but readable): both live, id order.
    const extA = rows.insert("accounts", { id: 10, external_id: "import:k~10" });
    const extB = rows.insert("accounts", { id: 11, external_id: "import:k" });
    const withIban = rows.insert("accounts", { id: 13, iban: "BW00000000000000000000000000" });
    const { vaults, counters } = phase1(driver);
    const a = (id: number) => vaults[0]?.accounts.get(id);
    const genesis = (id: number) => vaults[0]?.det("genesis", ["accounts", String(id)]);
    expect(a(first)?.keys).toEqual([`iban:${"0".repeat(26)}`]);
    expect(a(sameIban)).toMatchObject({ gid: genesis(sameIban), keys: [] });
    expect(a(extA)?.keys).toEqual(["ext:mbank:import:k"]);
    expect(a(extB)).toMatchObject({ gid: genesis(extB), keys: [] });
    // Same IBAN key as `first` (another country code, same key): a gid collision.
    expect(a(withIban)).toMatchObject({ gid: genesis(withIban), keys: [] });
    expect(counters.get("accounts", "account_key_collision", 0)).toBe(3);
    expect([...(vaults[0]?.accounts.keys() ?? [])]).toEqual([first, sameIban, 10, 11, 13]);
  });

  it("lets a live account claim first: a removed one never takes the key it (re)uses", () => {
    const { driver, rows } = db();
    // Parked ext key: removed A (lower id) and live B under one Enable Banking uid.
    const parked = rows.insert("accounts", {
      id: 1,
      bank: "eb",
      external_id: "U~1",
      removed_at: "2026-01-01 00:00:00.000000",
    });
    const live = rows.insert("accounts", { id: 2, bank: "eb", external_id: "U" });
    // Shared IBAN: a removed account and a live one with one IBAN, no external key.
    const removedIban = rows.insert("accounts", {
      id: 3,
      iban: ZERO_KEY_IBAN,
      removed_at: "2026-01-01 00:00:00.000000",
    });
    const liveIban = rows.insert("accounts", { id: 4, iban: ZERO_KEY_IBAN });
    const { vaults, counters } = phase1(driver);
    const a = (id: number) => vaults[0]?.accounts.get(id);
    const det = vaults[0]?.det;
    const genesis = (id: number) => det?.("genesis", ["accounts", String(id)]);
    expect(a(live)).toEqual({
      gid: det?.("accounts", ["ext", "eb", "U"]),
      keys: ["ext:eb:U"],
      externalId: "U",
    });
    expect(a(parked)).toEqual({ gid: genesis(parked), keys: [], externalId: "U" });
    expect(a(liveIban)).toEqual({
      gid: det?.("accounts", ["iban", "0".repeat(26)]),
      keys: [`iban:${"0".repeat(26)}`],
      externalId: null,
    });
    expect(a(removedIban)).toEqual({ gid: genesis(removedIban), keys: [], externalId: null });
    expect(counters.get("accounts", "account_key_collision", 0)).toBe(2);
    // The removed losers keep their rows (and gids in the map, id order).
    expect([...(vaults[0]?.accounts.keys() ?? [])]).toEqual([1, 2, 3, 4]);
    expect(gidOf(vaults[0], "accounts", parked)).toBe(genesis(parked));
  });
});

describe("ids (impl notes change 3)", () => {
  it("lists every exported row under its Python local id, legs and decision links excluded", () => {
    const { driver, rows } = db();
    rows.insert("profiles", { slug: "beata" });
    rows.insert("profile_modules", { module_id: "investments" });
    const account = rows.insert("accounts", {});
    rows.insert("accounts", { profile_id: 2 });
    rows.insert("inv_account_settings", { account_id: account });
    const instrument = rows.insert("inv_instruments", {});
    rows.insert("inv_instrument_aliases", { instrument_id: instrument });
    rows.insert("watchlist_items", { instrument_id: instrument });
    rows.insert("watchlist_items", { profile_id: 2, instrument_id: instrument });
    const t = rows.insert("transactions", { account_id: account, dedup_hash: "b".repeat(40) });
    rows.insert("transactions", { account_id: account, dedup_hash: `cashleg:${t}` });
    const signal = rows.insert("inv_signals", {});
    const decision = rows.insert("inv_decisions", { signal_id: signal });
    rows.insert("inv_decision_signals", { decision_id: decision, signal_id: signal });

    const { vaults } = phase1(driver);
    const [anna, beata] = vaults;
    const entries = (anna?.ids ?? []).map((e) => `${e.table} ${e.localId}`);
    expect(entries).toEqual([
      "profiles 1",
      "profile_modules 1|investments",
      "accounts 1",
      "inv_instruments 1",
      "inv_instrument_aliases 1",
      "transactions 1",
      "inv_account_settings 1",
      "watchlist_items 1",
      "inv_signals 1",
      "inv_decisions 1",
    ]);
    expect(anna?.ids.find((e) => e.table === "profiles")?.gid).toBe(TEST_VAULT);
    // Instruments and aliases: once per vault that references them, with that vault's gids.
    const beataInstrument = beata?.ids.find((e) => e.table === "inv_instruments");
    expect(beataInstrument?.localId).toBe("1");
    expect(beataInstrument?.gid).not.toBe(gidOf(anna, "inv_instruments", 1));
  });

  it("leaves out rows a required reference cannot resolve (gid.md 7.6), counted once", () => {
    const { driver, rows } = db();
    rows.insert("profiles", { slug: "beata" });
    const account = rows.insert("accounts", {});
    const foreign = rows.insert("accounts", { profile_id: 2 });
    rows.insert("inv_import_batches", { account_id: foreign });
    rows.insert("connector_bindings", { account_id: foreign });
    rows.insert("inv_theses", { instrument_id: 99 });
    rows.insert("watchlist_items", { instrument_id: 99 });
    rows.insert("inv_position_snapshots", { account_id: account, instrument_id: 99 });
    rows.insert("inv_instrument_renames", { old_instrument_id: 99, new_instrument_id: 98 });
    rows.insert("inv_manual_valuations", { instrument_id: 99 });
    rows.insert("inv_profile_instruments", { instrument_id: 99 });
    rows.insert("transactions", {
      account_id: account,
      dedup_hash: "cashleg:77",
      category: "jedzenie",
      category_source: "manual_txn",
    });
    rows.insert("transactions", { account_id: account, dedup_hash: "cashleg:78" });

    const { vaults, counters } = phase1(driver);
    const v = vaults[0];
    for (const table of [
      "inv_import_batches",
      "connector_bindings",
      "inv_theses",
      "watchlist_items",
      "inv_position_snapshots",
      "inv_instrument_renames",
      "inv_manual_valuations",
      "inv_profile_instruments",
    ]) {
      expect(v?.resolver.gid(table, "1"), table).toBeUndefined();
      expect(counters.get(table, "dangling_required", 0), table).toBe(1);
    }
    expect(v?.cashLegClaims.size).toBe(0);
    expect(counters.get("transactions", "dangling_required", 0)).toBe(1);
    expect(v?.missingGid("inv_instruments", 99)).toBe(v?.det("genesis", ["inv_instruments", "99"]));
  });

  it("creates instruments under the ISIN alias, else the oldest alias, else the genesis gid", () => {
    const { driver, rows } = db();
    const byIsin = rows.insert("inv_instruments", {});
    rows.insert("inv_instrument_aliases", { instrument_id: byIsin, namespace: "xtb", value: "A" });
    rows.insert("inv_instrument_aliases", { instrument_id: byIsin, value: "XX0000000002" });
    const byOldest = rows.insert("inv_instruments", {});
    rows.insert("inv_instrument_aliases", {
      instrument_id: byOldest,
      namespace: "xtb",
      value: "B",
    });
    rows.insert("inv_instrument_aliases", {
      instrument_id: byOldest,
      namespace: "yahoo",
      value: "B",
    });
    const bare = rows.insert("inv_instruments", {});
    for (const id of [byIsin, byOldest, bare]) rows.insert("inv_theses", { instrument_id: id });
    const v = phase1(driver).vaults[0];
    expect(v?.instruments.get(byIsin)?.creationAlias).toBe("isin:XX0000000002");
    expect(v?.instruments.get(byOldest)?.creationAlias).toBe("xtb:B");
    expect(gidOf(v, "inv_instruments", byOldest)).toBe(v?.det("inv_instruments", ["xtb:B"]));
    expect(v?.instruments.get(bare)?.creationAlias).toBeNull();
    expect(gidOf(v, "inv_instruments", bare)).toBe(
      v?.det("genesis", ["inv_instruments", String(bare)]),
    );
    expect(v?.aliases.map((a) => a.id)).toEqual([1, 2, 3, 4]);
  });
});
