// `StoreOptions.companionReads` (S14): the companion derivers (month aggregates, recurring payments,
// search index) run only on a store opened with it (the phone). The public view and its hash are the
// same either way, a database toggled between the two gains or drops their tables on open without a
// whole-view rebuild, a companion query without them fails with a clear error, and snapshots carry
// none of their tables in either direction. Synthetic data only.
import type { IsoDate } from "@cashu/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { budgetSearch, companionMonth } from "./budget/companion-queries.js";
import { detGid } from "./gid.js";
import { CompanionReadsOffError, Store } from "./materialize.js";
import { builtinModules } from "./modules.js";
import { runQuery } from "./query.js";
import type { StoreModule } from "./registry.js";
import { exportSnapshot, importSnapshot, viewHash } from "./snapshot.js";
import type { SqlDriver } from "./sql/driver.js";
import { expectMonthsRecomputed, monthTables } from "./testing/months-oracle.js";
import { convergesProperty } from "./testing/property-script.js";
import { expectRecurringRecomputed, recurringState } from "./testing/recurring-oracle.js";
import { expectSearchIndexed, searchIndex } from "./testing/search-oracle.js";
import {
  EventFactory,
  inDesktopConfiguration,
  memoryDriver,
  openTestStore,
  TEST_SALT,
  TEST_VAULT,
  type TestEnvelope,
} from "./testing/store.js";
import { bumpVersion } from "./testing/upgrade.js";

const MONTH = { today: "2025-08-20" as IsoDate, currency: "PLN", lang: "pl" } as const;

const COMPANION_TABLES = [
  "fold_month_cat",
  "fold_month_day",
  "fold_month_rows",
  "fold_month_env",
  "fold_recurring",
  "fold_recurring_rows",
  "fold_recurring_keys",
  "fold_recurring_groups",
  "fold_recurring_env",
  "fold_txn_fts",
  "fold_txn_fts_rows",
  "fold_txn_fts_env",
];

const ACC = detGid(TEST_SALT, "accounts", ["ext", "mbank", "cr-1"]);

/** A card payment or income on the test account; `n` makes the dedup hash (and the gid) unique. */
function txnOf(f: EventFactory, opts: { readonly wall?: number } = {}) {
  return (n: number, date: string, amount: string, payee: string, description: string) => {
    const hash = n.toString(16).padStart(40, "0");
    return f.make(
      "txn.imported",
      detGid(TEST_SALT, "transactions", [ACC, hash, "0"]),
      {
        account: ACC,
        batch: null,
        bookingDate: date,
        valueDate: null,
        amount,
        currency: "PLN",
        counterpartyName: payee,
        counterpartyIban: null,
        description,
        reference: null,
        bankTransactionId: null,
        source: "csv",
        dedupHash: hash,
        occurrence: 0,
        raw: {},
      },
      opts.wall === undefined ? {} : { wall: opts.wall },
    );
  };
}

/** Two PLN accounts' card payments over 8 months, a monthly subscription and merchant rules. */
function events(): { readonly first: TestEnvelope[]; readonly second: TestEnvelope[] } {
  const f = new EventFactory();
  const acc = ACC;
  const pool = detGid(TEST_SALT, "accounts", ["ext", "manual", "cash:PLN"]);
  const open = (gid: string, bank: string, ext: string, type: string, name: string) =>
    f.make("account.opened", gid, {
      bank,
      externalId: ext,
      iban: null,
      currency: "PLN",
      type,
      name,
      keys: [`ext:${bank}:${ext}`],
    });
  const txn = txnOf(f);
  const first: TestEnvelope[] = [
    open(acc, "mbank", "cr-1", "checking", "Konto testowe"),
    open(pool, "manual", "cash:PLN", "cash", "Gotówka"),
  ];
  const second: TestEnvelope[] = [];
  for (let n = 0; n < 48; n++) {
    const month = 1 + (n % 8);
    const e = txn(
      n,
      `2025-0${month}-${String(1 + (n % 27)).padStart(2, "0")}`,
      `-${12 + n}.50`,
      `SKLEP ${n % 5}`,
      n % 2 === 0 ? "zakup kartą" : "płatność blik",
    );
    (month <= 5 ? first : second).push(e);
  }
  for (let n = 0; n < 8; n++) {
    const e = txn(0x5ab00 + n, `2025-0${1 + n}-12`, "-43.00", "NETFLIX CR", "platnosc karta");
    (n < 5 ? first : second).push(e);
  }
  first.push(txn(0x5ac00, "2025-03-10", "6200.00", "PRACODAWCA SP Z O O", "wynagrodzenie"));
  for (let n = 0; n < 5; n++) {
    const m = `SKLEP ${n}`;
    (n < 3 ? first : second).push(
      f.make("categoryRule.set", detGid(TEST_SALT, "category_rules", [m]), {
        merchantKey: m,
        category: ["groceries", "fuel", "home"][n % 3],
        source: "manual",
        locked: false, // required by categoryRule.set v1; without it the rule parks
      }),
    );
  }
  return { first, second };
}

/**
 * Events none of `events()` holds, written later (a second device): new card payments in August
 * (one of a new shop, one more month of the subscription is not among them) and two rule changes,
 * one moving an existing shop to another category, one for the new shop.
 */
function laterEvents(): TestEnvelope[] {
  const f = new EventFactory("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "01JD");
  const wall = 1_000_000; // after every event of `events()`
  const txn = txnOf(f, { wall });
  const rule = (merchantKey: string, category: string) =>
    f.make(
      "categoryRule.set",
      detGid(TEST_SALT, "category_rules", [merchantKey]),
      { merchantKey, category, source: "manual", locked: false },
      { wall },
    );
  return [
    txn(0x7a000, "2025-08-14", "-88.20", "SKLEP 0", "zakup kartą"),
    txn(0x7a001, "2025-08-15", "-31.00", "SKLEP NOWY", "płatność blik"),
    txn(0x7a002, "2025-08-18", "-14.90", "SKLEP NOWY", "zakup kartą"),
    rule("SKLEP 0", "fuel"),
    rule("SKLEP NOWY", "home"),
  ];
}

function open(driver: SqlDriver, companionReads: boolean, modules?: readonly StoreModule[]) {
  return Store.open({
    driver,
    vault: TEST_VAULT,
    salt: TEST_SALT,
    modules: modules ?? builtinModules(),
    companionReads,
  });
}

function tablesOf(store: Store): string[] {
  const names = new Set(
    store
      .read<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r.name),
  );
  return COMPANION_TABLES.filter((t) => names.has(t));
}

/** Every companion read the tests compare: the derived tables and two queries over them. */
function companionReads(store: Store): unknown {
  return {
    months: monthTables(store),
    recurring: recurringState(store),
    search: searchIndex(store),
    hits: ["sklep", "netflix", "12,50", "wynagrodzenie"].map(
      (q) => runQuery(store, budgetSearch, { q, lang: "pl" }).value,
    ),
    month: companionMonth((sql, ...p) => store.read(sql, ...p), MONTH),
  };
}

function expectCompanionCorrect(store: Store): void {
  expectMonthsRecomputed(store);
  expectRecurringRecomputed(store);
  expectSearchIndexed(store);
}

describe("StoreOptions.companionReads", () => {
  it("derives the same public view (hash) with and without the companion derivers", () => {
    const { first, second } = events();
    const phone = openTestStore({ driver: memoryDriver(), companionReads: true });
    const desktop = openTestStore({ driver: memoryDriver(), companionReads: false });
    for (const batch of [first, second]) {
      phone.applyEnvelopes(batch);
      desktop.applyEnvelopes(batch);
      expect(viewHash(desktop)).toEqual(viewHash(phone));
    }
    expect(tablesOf(phone)).toEqual(COMPANION_TABLES);
    expect(tablesOf(desktop)).toEqual([]);
    expect(desktop.modules.derivers.map((d) => d.id)).toEqual([
      "budget.legs",
      "budget.transfers",
      "budget.categories",
    ]);
    // the categories deriver hands nothing over without the derivers that take it
    expect(desktop.read("SELECT row FROM fold_category_changes")).toEqual([]);
    expect(phone.read("SELECT row FROM fold_category_changes")).toEqual([]);
    expectCompanionCorrect(phone);
  });

  it("fails a companion query clearly on a store without them", () => {
    const desktop = openTestStore({ driver: memoryDriver(), companionReads: false });
    desktop.applyEnvelopes(events().first);
    expect(() => runQuery(desktop, budgetSearch, { q: "sklep", lang: "pl" })).toThrow(
      CompanionReadsOffError,
    );
    expect(() => companionMonth((sql, ...p) => desktop.read(sql, ...p), MONTH)).toThrow(
      CompanionReadsOffError,
    );
    // any other missing table stays the driver's own error
    expect(() => desktop.read("SELECT * FROM no_such_table")).toThrow(/no such table/);
    expect(() => desktop.read("SELECT * FROM no_such_table")).not.toThrow(CompanionReadsOffError);
  });

  it("opens one file with, without and with again: tables dropped, rebuilt, reads correct", () => {
    const { first, second } = events();
    const driver = memoryDriver();
    const phone = open(driver, true);
    phone.applyEnvelopes(first);
    const hashWith = viewHash(phone).hash;
    phone.detach();

    // without: their tables dropped, nothing re-folded or re-derived (no whole-view rebuild)
    const desktop = open(driver, false);
    expect(desktop.lastRebuild).toMatchObject({
      scope: "partial",
      materializers: [],
      derivers: [],
    });
    expect(tablesOf(desktop)).toEqual([]);
    expect(viewHash(desktop).hash).toBe(hashWith);
    desktop.applyEnvelopes(second); // the desktop keeps folding without them
    desktop.detach();
    expect(open(driver, false).lastRebuild).toBeNull(); // and reopens with no work
    open(driver, false).detach();

    // with again: only the companion derivers run their `deriveAll`
    const again = open(driver, true);
    expect(again.lastRebuild).toMatchObject({
      scope: "partial",
      materializers: [],
      derivers: ["budget.recurring", "budget.months", "budget.search"],
    });
    expect(tablesOf(again)).toEqual(COMPANION_TABLES);
    expectCompanionCorrect(again);
    // the oracle: a phone that saw every event from the start
    const fresh = openTestStore({ driver: memoryDriver(), companionReads: true });
    fresh.applyEnvelopes(first);
    fresh.applyEnvelopes(second);
    expect(companionReads(again)).toEqual(companionReads(fresh));
    expect(viewHash(again).hash).toBe(viewHash(fresh).hash);
    // and it keeps deriving incrementally afterwards: new rows and a category rule change after the
    // toggle (the categories deriver records again, the months deriver takes it)
    const later = laterEvents();
    again.applyEnvelopes(later);
    fresh.applyEnvelopes(later);
    expectCompanionCorrect(again);
    expect(again.read("SELECT row FROM fold_category_changes")).toEqual([]); // taken, none left
    expect(companionReads(again)).toEqual(companionReads(fresh));
    expect(viewHash(again).hash).toBe(viewHash(fresh).hash);
    // the new rows really reached the companion reads: the new shop is found, in its category
    const hits = runQuery(again, budgetSearch, { q: "sklep nowy", lang: "pl" }).value;
    expect(JSON.stringify(hits)).toContain("SKLEP NOWY");
    expect(
      again.read<{ n: number }>(
        "SELECT count(*) AS n FROM transactions WHERE category = 'fuel' AND merchant_key = 'SKLEP 0'",
      )[0]?.n,
    ).toBeGreaterThan(0);
  });

  it("imports a snapshot across the setting: no companion table in it, rebuilt where they run", () => {
    const { first, second } = events();
    const desktop = openTestStore({ driver: memoryDriver(), companionReads: false });
    const phone = openTestStore({ driver: memoryDriver(), companionReads: true });
    for (const s of [desktop, phone]) {
      s.applyEnvelopes(first);
      s.applyEnvelopes(second);
    }
    const fromDesktop = exportSnapshot(desktop);
    const fromPhone = exportSnapshot(phone);
    for (const snap of [fromDesktop, fromPhone]) {
      for (const t of COMPANION_TABLES) expect(Object.keys(snap.tables)).not.toContain(t);
    }
    expect(fromPhone.viewHash).toBe(fromDesktop.viewHash);

    const base = { vault: TEST_VAULT, salt: TEST_SALT, modules: builtinModules() };
    // desktop snapshot -> phone: the view taken as is (hash checked), the companion tables derived
    const onPhone = importSnapshot(
      { ...base, driver: memoryDriver(), companionReads: true },
      JSON.parse(JSON.stringify(fromDesktop)),
    );
    expect(onPhone.lastRebuild).toBeNull();
    expect(companionReads(onPhone)).toEqual(companionReads(phone));
    expectCompanionCorrect(onPhone);
    // phone snapshot -> desktop: nothing of the companion derivers comes along
    const onDesktop = importSnapshot(
      { ...base, driver: memoryDriver(), companionReads: false },
      JSON.parse(JSON.stringify(fromPhone)),
    );
    expect(onDesktop.lastRebuild).toBeNull();
    expect(tablesOf(onDesktop)).toEqual([]);
    expect(viewHash(onDesktop).hash).toBe(viewHash(desktop).hash);
    // the record of each store stays its own: reopening rebuilds nothing
    onPhone.detach();
    expect(open(onPhone.driver, true).lastRebuild).toBeNull();
    onDesktop.detach();
    expect(open(onDesktop.driver, false).lastRebuild).toBeNull();
  });

  it("imports a phone snapshot across a partial upgrade (a categories bump)", () => {
    const { first, second } = events();
    const phone = openTestStore({ driver: memoryDriver(), companionReads: true });
    phone.applyEnvelopes(first);
    phone.applyEnvelopes(second);
    const snap = JSON.parse(JSON.stringify(exportSnapshot(phone)));
    // the next release ships `budget.categories` at version + 1: the open re-runs that deriver and
    // the derivers after it (companion ones among them); the rest of the omitted tables (none left
    // here, but checked) are rebuilt by the import, and no excepted owner's table counts as orphan
    const imported = importSnapshot(
      {
        vault: TEST_VAULT,
        salt: TEST_SALT,
        modules: bumpVersion(builtinModules(), "budget.categories"),
        driver: memoryDriver(),
        companionReads: true,
      },
      snap,
    );
    expect(imported.lastRebuild).toMatchObject({ scope: "partial" });
    expect(imported.lastRebuild?.derivers).toEqual(
      expect.arrayContaining([
        "budget.categories",
        "budget.recurring",
        "budget.months",
        "budget.search",
      ]),
    );
    expect(tablesOf(imported)).toEqual(COMPANION_TABLES);
    expectCompanionCorrect(imported);
    // the oracle: the phone that saw every event (the bump changes no logic)
    expect(companionReads(imported)).toEqual(companionReads(phone));
    expect(viewHash(imported).hash).toBe(viewHash(phone).hash);
  });

  it("the convergence property holds in the desktop configuration (option off)", () => {
    inDesktopConfiguration(() => {
      // the suite's stores really are desktop stores here
      const probe = openTestStore();
      expect(tablesOf(probe)).toEqual([]);
      expect(probe.modules.derivers.map((d) => d.id)).not.toContain("budget.months");
      // permutations and duplicates give one view hash; deriveAll changes nothing; the categories
      // equal the domain recompute; a rebuild gives the incremental hash
      fc.assert(convergesProperty, { numRuns: 15 });
    });
    expect(tablesOf(openTestStore())).toEqual(COMPANION_TABLES); // the default is back
  });

  it("refuses a deriver registered after a companion one", () => {
    const modules = builtinModules().map((m) => {
      const legs = m.derivers?.[0];
      if (m.id !== "budget" || legs === undefined) return m;
      return { ...m, derivers: [...(m.derivers ?? []), { ...legs, id: "x.y" }] };
    });
    expect(() => open(memoryDriver(), false, modules)).toThrow(/comes after the companion/);
  });
});
