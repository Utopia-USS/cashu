// Core commands (S24 5) on the in-memory store: batch shapes, validation, value-free refusals,
// idempotent re-runs, account identity across IBAN formats (Python tests/test_ingestion.py
// test_account_merges_across_iban_formats), name keys and vault isolation (tests/test_profiles.py
// isolation idea). Synthetic data only.
import { describe, expect, it } from "vitest";
import { vaultSalt } from "../gid.js";
import { Store } from "../materialize.js";
import { builtinModules } from "../modules.js";
import { run, testEnv } from "../testing/commands.js";
import { EventFactory, memoryDriver, openTestStore } from "../testing/store.js";
import {
  createProfile,
  openAccount,
  recordBalance,
  removeAccount,
  renameProfile,
  restoreAccount,
  setModules,
  setProfileSettings,
} from "./commands.js";
import { accountByGid, type Read } from "./queries.js";

/** The identity IBAN keys of every account (removed ones included; checksum-valid only, N2). */
const ownIbanKeys = (read: Read) =>
  new Set(
    read<{ iban_key: string }>("SELECT iban_key FROM accounts WHERE iban_key IS NOT NULL").map(
      (r) => r.iban_key,
    ),
  );

const reader =
  (store: Store): Read =>
  (sql, ...params) =>
    store.read(sql, ...params);

const types = (out: { ok: boolean; events?: readonly { type: string }[] }) =>
  out.ok ? (out.events ?? []).map((e) => e.type) : [];

describe("core commands: profile and modules", () => {
  it("createProfile emits the profile and every module with its dependencies", () => {
    const store = openTestStore();
    const env = testEnv();
    const out = run(store, env, createProfile, {
      slug: "dom",
      name: "  Dom  ",
      modules: ["loans"],
    });
    expect(types(out)).toEqual(["profile.created", "module.enabled"]);
    expect(store.read("SELECT slug, name, base_currency, mcp_privacy FROM profiles")).toEqual([
      { slug: "dom", name: "Dom", base_currency: "PLN", mcp_privacy: "strict" },
    ]);
    expect(run(store, env, createProfile, { slug: "dom", name: "X" })).toEqual({
      ok: false,
      reason: "exists",
    });
  });

  it("refuses invalid profile data with value-free reasons", () => {
    const store = openTestStore();
    const env = testEnv();
    expect(run(store, env, createProfile, { slug: "d", name: " " })).toMatchObject({
      reason: "invalid_name",
    });
    expect(
      run(store, env, createProfile, { slug: "d", name: "D", baseCurrency: "zł" }),
    ).toMatchObject({ reason: "invalid_currency" });
    expect(run(store, env, createProfile, { slug: "d", name: "D", modules: ["x"] })).toMatchObject({
      reason: "unknown_module",
    });
    expect(run(store, env, createProfile, { slug: "D!", name: "D" })).toMatchObject({
      reason: "invalid_input",
    });
    expect(run(store, env, renameProfile, { name: "X" })).toMatchObject({ reason: "no_profile" });
  });

  it("setModules emits only the registers that change; enabled_at moves on a re-enable", () => {
    const store = openTestStore();
    const env = testEnv();
    run(store, env, createProfile, { slug: "dom", name: "Dom", modules: ["budget"] });
    expect(types(run(store, env, setModules, { moduleIds: ["budget"] }))).toEqual([]);
    expect(types(run(store, env, setModules, { moduleIds: ["assets"] }))).toEqual([
      "module.disabled", // budget (registry order)
      "module.enabled", // assets
    ]);
    const first = store.read<{ enabled_at: string }>(
      "SELECT enabled_at FROM profile_modules WHERE module_id = 'budget'",
    )[0]?.enabled_at;
    env.advance(60_000);
    run(store, env, setModules, { moduleIds: ["budget", "assets"] });
    const again = store.read<{ enabled: number; enabled_at: string }>(
      "SELECT enabled, enabled_at FROM profile_modules WHERE module_id = 'budget'",
    )[0];
    expect(again?.enabled).toBe(1);
    expect((again?.enabled_at ?? "") > (first ?? "")).toBe(true);
  });

  it("settings and rename emit only changed fields", () => {
    const store = openTestStore();
    const env = testEnv();
    run(store, env, createProfile, { slug: "dom", name: "Dom" });
    expect(types(run(store, env, renameProfile, { name: "Dom" }))).toEqual([]);
    const out = run(store, env, setProfileSettings, { baseCurrency: "eur", mcpPrivacy: "strict" });
    expect(out.ok && out.events.map((e) => e.data)).toEqual([{ baseCurrency: "EUR" }]);
  });
});

describe("core commands: accounts", () => {
  it("open by IBAN: DET gid and keys; again: nothing; the full IBAN joins the bare NRB account", () => {
    const store = openTestStore();
    const env = testEnv();
    const nrb = "61109010140000071219812874";
    const a = run(store, env, openAccount, {
      bank: "mbank",
      name: "mBank główne",
      type: "checking",
      currency: "PLN",
      iban: nrb,
    });
    expect(a.ok && a.events[0]?.data).toMatchObject({
      externalId: `csv:${nrb}`,
      keys: [`iban:${nrb}`, `ext:mbank:csv:${nrb}`],
    });
    expect(a.ok && a.events[0]?.gid).toBe(store.deps.det("accounts", ["iban", nrb]));
    expect(
      types(
        run(store, env, openAccount, {
          bank: "mbank",
          type: "checking",
          currency: "PLN",
          iban: nrb,
        }),
      ),
    ).toEqual([]);
    const b = run(store, env, openAccount, {
      bank: "mbank",
      type: "checking",
      currency: "PLN",
      iban: `PL${nrb}`,
      externalId: "eb-uid-1",
    });
    expect(b.ok && b.value.account).toBe(a.ok && a.value.account);
    expect(types(b)).toEqual(["account.identified"]); // claims the new uid key only
    expect(store.read("SELECT COUNT(*) AS n FROM accounts")).toEqual([{ n: 1 }]);
    expect(store.read("SELECT name FROM accounts")).toEqual([{ name: "mBank główne" }]);
  });

  it("a name key gets a ULID and no identity key; a removed holder is not revived", () => {
    const store = openTestStore();
    const env = testEnv();
    const spec = {
      bank: "manual",
      name: "Dom",
      type: "property",
      currency: "PLN",
      externalId: "manual:Dom",
    };
    const a = run(store, env, openAccount, spec);
    expect(a.ok && a.events[0]?.data.keys).toEqual([]);
    const first = a.ok ? a.value.account : "";
    run(store, env, removeAccount, { account: first });
    const b = run(store, env, openAccount, spec);
    expect(b.ok && b.value.created).toBe(true);
    const second = b.ok ? b.value.account : "";
    expect(store.read("SELECT gid, external_id FROM accounts ORDER BY id")).toEqual([
      { gid: first, external_id: `manual:Dom~${first}` },
      { gid: second, external_id: "manual:Dom" },
    ]);
    expect(types(run(store, env, removeAccount, { account: first }))).toEqual([]); // idempotent
    expect(types(run(store, env, restoreAccount, { account: first }))).toEqual([
      "account.restored",
    ]);
  });

  // A synthetic NRB with valid mod-97 check digits, and the same number one digit off.
  const VALID = "61109010140000071219812874";
  const INVALID = "61109010140000071219812875";

  it("an IBAN failing the checksum is stored and shown raw, but never claimed as a key", () => {
    const store = openTestStore();
    const env = testEnv();
    const a = run(store, env, openAccount, {
      bank: "mbank",
      type: "checking",
      currency: "PLN",
      iban: INVALID,
      externalId: "eb-uid-9",
    });
    expect(a.ok && a.events[0]?.data).toMatchObject({
      iban: INVALID,
      keys: ["ext:mbank:eb-uid-9"],
    });
    const account = a.ok ? a.value.account : "";
    expect(accountByGid(reader(store), account)).toMatchObject({ iban: INVALID, ibanKey: null });
    // transfer matching (own IBAN keys) never sees it (rule 5)
    expect(ownIbanKeys(reader(store))).toEqual(new Set());
    // the same number again lands on the same account, without a key
    const again = run(store, env, openAccount, {
      bank: "mbank",
      type: "checking",
      currency: "PLN",
      iban: INVALID,
    });
    expect(again.ok && again.value.account).toBe(account);
    expect(store.read("SELECT COUNT(*) AS n FROM accounts")).toEqual([{ n: 1 }]);
    expect(store.read("SELECT COUNT(*) AS n FROM account_conflicts")).toEqual([{ n: 0 }]);
  });

  it("a valid IBAN learned later takes the key and the display from the raw one", () => {
    const store = openTestStore();
    const env = testEnv();
    const spec = { bank: "mbank", type: "checking", currency: "PLN", externalId: "eb-uid-9" };
    const a = run(store, env, openAccount, { ...spec, iban: INVALID });
    const b = run(store, env, openAccount, { ...spec, iban: `PL${VALID}` });
    expect(b.ok && b.value.account).toBe(a.ok && a.value.account);
    expect(b.ok && b.events.map((e) => [e.type, e.data])).toEqual([
      ["account.identified", { iban: `PL${VALID}`, keys: [`iban:${VALID}`] }],
    ]);
    expect(accountByGid(reader(store), b.ok ? b.value.account : "")).toMatchObject({
      iban: `PL${VALID}`,
      ibanKey: VALID,
    });
    expect(ownIbanKeys(reader(store))).toEqual(new Set([VALID]));
    expect(store.read("SELECT iban_match FROM accounts")).toEqual([{ iban_match: VALID }]);
  });

  it("keeps the match key of a removed account and leaves it null without an IBAN", () => {
    const store = openTestStore();
    const env = testEnv();
    const a = run(store, env, openAccount, {
      bank: "mbank",
      type: "checking",
      currency: "PLN",
      iban: ` pl ${INVALID} `,
    });
    run(store, env, openAccount, {
      bank: "manual",
      name: "Sejf",
      type: "savings",
      currency: "PLN",
      externalId: "manual:Sejf",
    });
    run(store, env, removeAccount, { account: a.ok ? a.value.account : "" });
    expect(
      store.read(
        "SELECT iban_match, removed_at IS NOT NULL AS removed FROM accounts ORDER BY iban_match",
      ),
    ).toEqual([
      { iban_match: null, removed: 0 },
      { iban_match: INVALID, removed: 1 },
    ]);
  });

  it("an account showing only a raw IBAN is found by it, wherever its gid came from", () => {
    // e.g. a genesis account keyed by its external id that carries a number failing the checksum
    const store = openTestStore();
    const f = new EventFactory();
    const gid = store.deps.det("accounts", ["ext", "mbank", "eb-uid-7"]);
    store.applyEnvelopes([
      f.make("account.opened", gid, {
        bank: "mbank",
        externalId: "eb-uid-7",
        iban: `PL${INVALID}`,
        currency: "PLN",
        type: "checking",
        name: "Konto",
        keys: ["ext:mbank:eb-uid-7"],
      }),
    ]);
    const out = run(store, testEnv(), openAccount, {
      bank: "mbank",
      type: "checking",
      currency: "PLN",
      iban: INVALID,
    });
    expect(out.ok && out.value).toMatchObject({ account: gid, created: false });
    expect(types(out)).toEqual([]);
    // the match column (D-08.1) is Python's iban_key of the raw number, checksum or not
    expect(store.read("SELECT iban, iban_key, iban_match FROM accounts")).toEqual([
      { iban: `PL${INVALID}`, iban_key: null, iban_match: INVALID },
    ]);
  });

  it("recordBalance defaults to the account's currency; unknown accounts are refused", () => {
    const store = openTestStore();
    const env = testEnv();
    const a = run(store, env, openAccount, {
      bank: "manual",
      name: "Sejf",
      type: "savings",
      currency: "EUR",
      externalId: "manual:Sejf",
    });
    const account = a.ok ? a.value.account : "";
    run(store, env, recordBalance, { account, date: "2026-10-30", amount: 1250.5 });
    expect(store.read("SELECT amount, currency, source FROM balances")).toEqual([
      { amount: "1250.5", currency: "EUR", source: "manual" },
    ]);
    expect(
      run(store, env, recordBalance, {
        account: "01JD0000000000000000000099",
        date: "2026-10-30",
        amount: "1",
      }),
    ).toMatchObject({ reason: "no_account" });
  });
});

describe("vault isolation (one store per vault)", () => {
  it("commands of one vault touch nothing of another; a store refuses another vault's database", () => {
    const a = openTestStore();
    const otherVault = "0123456789abcdef0123456789abcdef";
    const driver = memoryDriver();
    const b = Store.open({
      driver,
      vault: otherVault,
      salt: vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => 255 - i)),
      modules: builtinModules(),
    });
    const env = testEnv();
    run(a, env, createProfile, { slug: "dom", name: "Dom", modules: ["budget"] });
    run(b, env, createProfile, { slug: "dom", name: "Dom", modules: ["budget"] });
    const spec = {
      bank: "mbank",
      type: "checking",
      currency: "PLN",
      iban: "61109010140000071219812874",
    };
    const inA = run(a, env, openAccount, spec);
    const inB = run(b, env, openAccount, spec);
    // the same IBAN gives another gid in another vault (per-vault salt, gid.md 3)
    expect(inA.ok && inB.ok && inA.value.account !== inB.value.account).toBe(true);
    run(a, env, removeAccount, { account: inA.ok ? inA.value.account : "" });
    expect(b.read("SELECT removed_at FROM accounts")).toEqual([{ removed_at: null }]);
    expect(run(b, env, removeAccount, { account: inA.ok ? inA.value.account : "" })).toMatchObject({
      reason: "no_account",
    });
    expect(() =>
      Store.open({
        driver,
        vault: a.vault,
        salt: vaultSalt(new Uint8Array(32)),
        modules: builtinModules(),
      }),
    ).toThrow(/another vault/);
  });
});
