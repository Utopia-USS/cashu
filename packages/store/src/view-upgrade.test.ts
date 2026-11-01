/// <reference types="node" />
// App updates that change a fold or the view schema (events.md 7.9, M10): the open after the update
// rebuilds what the upgrade rule in rebuild.ts selects, the result equals a fresh fold of the same
// log with the new definitions, a crash mid-rebuild never leaves a half-rebuilt view, and an open with
// unchanged definitions rebuilds nothing. Synthetic data only.
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Materializer } from "./engine/types.js";
import { detGid } from "./gid.js";
import { Store } from "./materialize.js";
import { builtinModules } from "./modules.js";
import type { RebuildProgress } from "./rebuild.js";
import type { StoreModule } from "./registry.js";
import { viewHash } from "./snapshot.js";
import { betterSqlite3Driver } from "./sql/better-sqlite3.js";
import type { SqlDriver } from "./sql/driver.js";
import {
  EventFactory,
  memoryDriver,
  openTestStore,
  TEST_SALT,
  TEST_VAULT,
  type TestEnvelope,
  testUlid,
} from "./testing/store.js";
import { bumpVersion } from "./testing/upgrade.js";

// ---------------------------------------------------------------------------------------------- //
// A test module: notes folded into `test_notes`. v2 of the fold upper-cases the body (a changed
// fold), the "wide" variant adds a column (a view schema change at the same version).

const notesTable = {
  name: "test_notes",
  columns: [{ name: "body", type: "TEXT" as const, notNull: true }],
};

function notesFold(version: number, transform: (s: string) => string): Materializer {
  return {
    id: "test.notes",
    version,
    tables: [notesTable],
    handles: ["testNote.set"],
    partitions: (e) => [e.gid],
    clear(gids, ctx) {
      for (const g of gids) ctx.sql.write("test_notes", "DELETE FROM test_notes WHERE gid = ?", g);
    },
    apply(e, ctx) {
      ctx.sql.insert(
        "test_notes",
        "INSERT OR REPLACE INTO test_notes (id, gid, body)",
        "(?, ?, ?)",
        ctx.id(e.gid),
        e.gid,
        transform(String(e.data.text)),
      );
    },
  };
}

const notesV1 = notesFold(1, (s) => s);
const notesV2 = notesFold(2, (s) => s.toUpperCase());

const notesWide: Materializer = {
  ...notesV1,
  tables: [
    {
      name: "test_notes",
      columns: [
        { name: "body", type: "TEXT", notNull: true },
        { name: "length", type: "INTEGER", notNull: true },
      ],
    },
  ],
  apply(e, ctx) {
    const text = String(e.data.text);
    ctx.sql.insert(
      "test_notes",
      "INSERT OR REPLACE INTO test_notes (id, gid, body, length)",
      "(?, ?, ?, ?)",
      ctx.id(e.gid),
      e.gid,
      text,
      text.length,
    );
  },
};

const meta = { table: "test_notes", rule: "LWW-F", gid: "ULID", emitter: "any" } as const;
const noteEvents = [
  { type: "testNote.set", v: 1, schema: z.looseObject({ text: z.string() }), meta },
] as const;

function withNotes(mat: Materializer): StoreModule[] {
  return [...builtinModules(), { id: "test", materializers: [mat], events: noteEvents }];
}

// ---------------------------------------------------------------------------------------------- //
// A small budget vault: accounts, imports, rules, claims (manual cash withdrawals make cash legs).

function budgetEvents(): TestEnvelope[] {
  const f = new EventFactory();
  const acc = detGid(TEST_SALT, "accounts", ["ext", "mbank", "upg-1"]);
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
  const out = [
    open(acc, "mbank", "upg-1", "checking", "Konto testowe"),
    open(pool, "manual", "cash:PLN", "cash", "Gotówka"),
  ];
  const imports: TestEnvelope[] = [];
  for (let n = 0; n < 60; n++) {
    const hash = `upg-${String(n).padStart(4, "0")}`;
    const e = f.make("txn.imported", detGid(TEST_SALT, "transactions", [acc, hash, "0"]), {
      account: acc,
      batch: null,
      bookingDate: `2025-0${1 + (n % 6)}-${String(1 + (n % 28)).padStart(2, "0")}`,
      valueDate: null,
      amount: `-${10 + n}.00`,
      currency: "PLN",
      counterpartyName: `SKLEP ${n % 7}`,
      counterpartyIban: null,
      description: "zakup",
      reference: null,
      bankTransactionId: null,
      source: "csv",
      dedupHash: hash,
      occurrence: 0,
      raw: {},
    });
    imports.push(e);
    out.push(e);
  }
  for (let n = 0; n < 7; n++) {
    const m = `SKLEP ${n}`;
    out.push(
      f.make("categoryRule.set", detGid(TEST_SALT, "category_rules", [m]), {
        merchantKey: m,
        category: ["groceries", "fuel", "home"][n % 3],
        source: "manual",
        locked: true,
      }),
    );
  }
  for (let n = 0; n < 12; n++) {
    out.push(
      f.make("txn.categorySet", (imports[n * 5] as TestEnvelope).gid, {
        category: n % 3 === 0 ? "cash_withdrawal" : "groceries",
        source: "manual_txn",
      }),
    );
  }
  return out;
}

function noteEnvelopes(count: number): TestEnvelope[] {
  const f = new EventFactory("cccccccccccccccccccccccccccccccc", "01JN");
  return Array.from({ length: count }, (_, n) =>
    f.make("testNote.set", testUlid("01JM", n + 1), { text: `notatka ${n}` }),
  );
}

/** The view a reader new from the start folds from `events` with `modules`. */
function freshHash(modules: readonly StoreModule[], events: readonly TestEnvelope[]): string {
  const fresh = openTestStore({ modules });
  for (let i = 0; i < events.length; i += 1000) fresh.applyEnvelopes(events.slice(i, i + 1000));
  return viewHash(fresh).hash;
}

function reopen(driver: SqlDriver, modules: readonly StoreModule[], progress?: RebuildProgress[]) {
  return Store.open({
    driver,
    vault: TEST_VAULT,
    salt: TEST_SALT,
    modules,
    ...(progress ? { onRebuild: (p: RebuildProgress) => progress.push(p) } : {}),
  });
}

/** A store on `driver` with `events` applied under `modules`, closed cleanly (the old app). */
function oldApp(driver: SqlDriver, modules: readonly StoreModule[], events: TestEnvelope[]) {
  const store = reopen(driver, modules);
  for (let i = 0; i < events.length; i += 1000) store.applyEnvelopes(events.slice(i, i + 1000));
  const hash = viewHash(store).hash;
  store.detach();
  return hash;
}

describe("view upgrade on open (events.md 7.9)", () => {
  it("re-folds only a materializer whose version was bumped, equal to a fresh fold", () => {
    const events = [...budgetEvents(), ...noteEnvelopes(20)];
    const driver = memoryDriver();
    oldApp(driver, withNotes(notesV1), events);
    const progress: RebuildProgress[] = [];
    const upgraded = reopen(driver, withNotes(notesV2), progress);
    expect(upgraded.lastRebuild).toMatchObject({
      scope: "partial",
      reason: "definitions",
      materializers: ["test.notes"],
      derivers: [],
    });
    expect(upgraded.lastRebuild?.touchedTables).toEqual(new Set(["test_notes"]));
    expect(upgraded.read("SELECT body FROM test_notes ORDER BY body LIMIT 1")).toEqual([
      { body: "NOTATKA 0" },
    ]);
    expect(viewHash(upgraded).hash).toBe(freshHash(withNotes(notesV2), events));
    // later applies keep folding incrementally on the rebuilt view
    const more = noteEnvelopes(25).slice(20);
    upgraded.applyEnvelopes(more);
    expect(viewHash(upgraded).hash).toBe(freshHash(withNotes(notesV2), [...events, ...more]));
    expect(progress.map((p) => p.phase)).toEqual(["start", "step", "fold", "done"]);
  });

  it("rebuilds a table whose schema changed at the same version", () => {
    const events = noteEnvelopes(10);
    const driver = memoryDriver();
    oldApp(driver, withNotes(notesV1), events);
    const upgraded = reopen(driver, withNotes(notesWide));
    expect(upgraded.lastRebuild).toMatchObject({ scope: "partial", materializers: ["test.notes"] });
    expect(upgraded.read("SELECT MIN(length) AS n FROM test_notes")).toEqual([{ n: 9 }]);
    expect(viewHash(upgraded).hash).toBe(freshHash(withNotes(notesWide), events));
  });

  it("folds an added materializer and drops a removed one's tables", () => {
    // the event type stays registered (its events stay decodable): only the fold comes and goes
    const bare: StoreModule[] = [
      ...builtinModules(),
      { id: "test", materializers: [], events: noteEvents },
    ];
    const events = [...budgetEvents(), ...noteEnvelopes(5)];
    const driver = memoryDriver();
    oldApp(driver, bare, events);
    const added = reopen(driver, withNotes(notesV1));
    expect(added.lastRebuild).toMatchObject({ scope: "partial", materializers: ["test.notes"] });
    expect(viewHash(added).hash).toBe(freshHash(withNotes(notesV1), events));
    added.detach();
    const removed = reopen(driver, bare);
    expect(removed.lastRebuild).toMatchObject({ scope: "partial", materializers: [] });
    expect(
      removed.read(
        "SELECT name FROM sqlite_master WHERE name IN ('test_notes', 'members_test_notes')",
      ),
    ).toEqual([]);
    expect(
      removed.driver.prepare("SELECT 1 AS x FROM materializer_state WHERE id = 'test.notes'").get(),
    ).toBeUndefined();
    expect(viewHash(removed).hash).toBe(freshHash(bare, events));
  });

  it("re-folds a builtin materializer and the derivers that read or write its tables", () => {
    const events = budgetEvents();
    const driver = memoryDriver();
    oldApp(driver, builtinModules(), events);
    const rules = bumpVersion(builtinModules(), "budget.category_rules");
    const r1 = reopen(driver, rules);
    expect(r1.lastRebuild).toMatchObject({
      scope: "partial",
      materializers: ["budget.category_rules"],
      derivers: [],
    });
    expect(viewHash(r1).hash).toBe(freshHash(rules, events));
    r1.detach();
    // a deriver bump runs that deriver (and later ones that see its table), nothing else
    const cats = bumpVersion(rules, "budget.categories");
    const r2 = reopen(driver, cats);
    expect(r2.lastRebuild).toMatchObject({
      scope: "partial",
      materializers: [],
      derivers: ["budget.categories"],
    });
    expect(viewHash(r2).hash).toBe(freshHash(cats, events));
  });

  it("rebuilds the whole view when a changed materializer indexes refs or an identity kind changed", () => {
    const events = budgetEvents();
    const driver = memoryDriver();
    oldApp(driver, builtinModules(), events);
    const txns = bumpVersion(builtinModules(), "budget.transactions");
    const r1 = reopen(driver, txns);
    expect(r1.lastRebuild).toMatchObject({ scope: "full", reason: "refs" });
    expect(viewHash(r1).hash).toBe(freshHash(txns, events));
    r1.detach();
    const ident = bumpVersion(txns, "accounts");
    const r2 = reopen(driver, ident);
    expect(r2.lastRebuild).toMatchObject({ scope: "full", reason: "identity" });
    expect(viewHash(r2).hash).toBe(freshHash(ident, events));
  });

  it("records per-component definitions on a database from before them, without a rebuild", () => {
    const events = budgetEvents();
    const driver = memoryDriver();
    const before = oldApp(driver, builtinModules(), events);
    driver.prepare("DELETE FROM store_meta WHERE key = 'view_defs'").run();
    const same = reopen(driver, builtinModules());
    expect(same.lastRebuild).toBeNull();
    expect(viewHash(same).hash).toBe(before);
    expect(
      same.driver.prepare("SELECT 1 AS x FROM store_meta WHERE key = 'view_defs'").get(),
    ).toBeDefined();
    same.detach();
    // no record and changed definitions: the whole view
    driver.prepare("DELETE FROM store_meta WHERE key = 'view_defs'").run();
    const rules = bumpVersion(builtinModules(), "budget.category_rules");
    const upgraded = reopen(driver, rules);
    expect(upgraded.lastRebuild).toMatchObject({ scope: "full", reason: "unrecorded" });
    expect(viewHash(upgraded).hash).toBe(freshHash(rules, events));
  });

  it("rebuilds nothing when nothing changed", () => {
    const events = [...budgetEvents(), ...noteEnvelopes(10)];
    const driver = memoryDriver();
    const before = oldApp(driver, withNotes(notesV1), events);
    const progress: RebuildProgress[] = [];
    const same = reopen(driver, withNotes(notesV1), progress);
    expect(same.lastRebuild).toBeNull();
    expect(progress).toEqual([]);
    expect(viewHash(same).hash).toBe(before);
  });

  it("notifies subscribers of the rebuilt tables and reports progress to the end", () => {
    const store = openTestStore({ modules: withNotes(notesV1) });
    store.applyEnvelopes(noteEnvelopes(5000));
    const seen: string[][] = [];
    store.subscribe(["test_notes"], (t) => seen.push([...t]));
    const report = store.rebuild();
    expect(report.scope).toBe("full");
    expect(seen).toEqual([["test_notes"]]);
  });
});

describe("crash mid-rebuild", () => {
  it("rolls back a failed upgrade: the old app reads the old view, the next open rebuilds again", () => {
    const events = [...budgetEvents(), ...noteEnvelopes(50)];
    const driver = memoryDriver();
    const before = oldApp(driver, withNotes(notesV1), events);
    let applied = 0;
    const crashing: Materializer = {
      ...notesV2,
      apply(e, ctx) {
        applied += 1;
        if (applied === 30) throw new Error("injected crash");
        notesV2.apply(e, ctx);
      },
    };
    expect(() => reopen(driver, withNotes(crashing))).toThrow("injected crash");
    // nothing of the upgrade committed: the old definitions see their view, no rebuild
    const old = reopen(driver, withNotes(notesV1));
    expect(old.lastRebuild).toBeNull();
    expect(viewHash(old).hash).toBe(before);
    old.detach();
    const upgraded = reopen(driver, withNotes(notesV2));
    expect(upgraded.lastRebuild?.scope).toBe("partial");
    expect(viewHash(upgraded).hash).toBe(freshHash(withNotes(notesV2), events));
  });

  it("a progress listener that throws aborts the rebuild the same way", () => {
    const events = noteEnvelopes(10);
    const driver = memoryDriver();
    const before = oldApp(driver, withNotes(notesV1), events);
    expect(() =>
      Store.open({
        driver,
        vault: TEST_VAULT,
        salt: TEST_SALT,
        modules: withNotes(notesV2),
        onRebuild: (p) => {
          if (p.phase === "step") throw new Error("listener failed");
        },
      }),
    ).toThrow("listener failed");
    const old = reopen(driver, withNotes(notesV1));
    expect(viewHash(old).hash).toBe(before);
  });

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("a process killed mid-rebuild leaves the old view on disk and rebuilds on the next open", () => {
    const dir = mkdtempSync(join(tmpdir(), "cashu-upgrade-"));
    dirs.push(dir);
    const path = join(dir, "vault.db");
    const killed = join(dir, "killed.db");
    const fileDriver = (p: string, cachePages?: number) => {
      const db = new Database(p);
      if (cachePages !== undefined) db.pragma(`cache_size = ${cachePages}`);
      return betterSqlite3Driver(db);
    };
    const events = noteEnvelopes(9000);
    const d1 = fileDriver(path);
    const before = oldApp(d1, withNotes(notesV1), events);
    d1.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    d1.close();

    // The update's open, with a tiny page cache so the open transaction spills pages to the WAL.
    // Mid-fold, the files as they are on disk are copied: what a SIGKILL at that moment leaves.
    let walAtKill = 0;
    const d2 = fileDriver(path, 8);
    Store.open({
      driver: d2,
      vault: TEST_VAULT,
      salt: TEST_SALT,
      modules: withNotes(notesV2),
      onRebuild: (p) => {
        if (p.phase !== "fold" || p.folded !== 4096) return;
        copyFileSync(path, killed);
        if (existsSync(`${path}-wal`)) {
          copyFileSync(`${path}-wal`, `${killed}-wal`);
          walAtKill = statSync(`${killed}-wal`).size;
        }
      },
    }).close();
    expect(walAtKill).toBeGreaterThan(0); // uncommitted rebuild pages were on disk

    const oldReader = reopen(fileDriver(killed), withNotes(notesV1));
    expect(oldReader.lastRebuild).toBeNull();
    expect(viewHash(oldReader).hash).toBe(before);
    oldReader.close();
    const next = reopen(fileDriver(killed), withNotes(notesV2));
    expect(next.lastRebuild?.scope).toBe("partial");
    expect(viewHash(next).hash).toBe(freshHash(withNotes(notesV2), events));
    next.close();
  });
});
