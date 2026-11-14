/// <reference types="node" />
// Crash model of the view database (data-flow.md "Crash model"): a damaged database is detected on
// open and replaced by a new one, which the carrier then fills by replaying the encrypted log.
import { closeSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./materialize.js";
import { builtinModules } from "./modules.js";
import { viewHash } from "./snapshot.js";
import { betterSqlite3Driver } from "./sql/better-sqlite3.js";
import { EventFactory, TEST_SALT, TEST_VAULT, type TestEnvelope } from "./testing/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function vaultFile() {
  const dir = mkdtempSync(join(tmpdir(), "cashu-store-"));
  dirs.push(dir);
  const path = join(dir, "vault.db");
  return {
    path,
    open: () =>
      Store.openOrRecover({
        vault: TEST_VAULT,
        salt: TEST_SALT,
        modules: builtinModules(),
        connect: () => betterSqlite3Driver(new Database(path)),
        discard: () => {
          for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
        },
      }),
  };
}

const ACC = "70cc61c8-79b5-80ae-b8cc-fdca7caef49e";

function events(): TestEnvelope[] {
  const f = new EventFactory();
  const out: TestEnvelope[] = [
    f.make("account.opened", ACC, {
      bank: "mbank",
      externalId: null,
      iban: null,
      currency: "PLN",
      type: "checking",
      name: "Konto testowe",
      keys: [],
    }),
  ];
  for (let n = 0; n < 300; n++) {
    out.push(
      f.make("categoryRule.set", `${"cc9078fc-ae3d-8c1d-8381-"}${String(n).padStart(12, "0")}`, {
        merchantKey: `SKLEP ${n}`,
        category: "groceries",
        source: "manual",
        locked: true,
      }),
    );
  }
  return out;
}

/** Simulate a crash: drop the handle without `close()` (the session marker stays set). */
function crash(store: Store): void {
  (store.driver as unknown as { close(): void }).close();
}

/** Overwrite `length` bytes at `offset` with garbage (a torn page). */
function tear(path: string, offset: number, length: number): void {
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.alloc(length, 0xa5), 0, length, offset);
  } finally {
    closeSync(fd);
  }
}

describe("crash model of the view database", () => {
  it("reopens a cleanly closed database as it was", () => {
    const v = vaultFile();
    const { store } = v.open();
    store.applyEnvelopes(events());
    const hash = viewHash(store).hash;
    store.close();
    const again = v.open();
    expect(again.recovered).toBe(false);
    expect(viewHash(again.store).hash).toBe(hash);
    again.store.close();
  });

  it("keeps a crashed but intact database (WAL rolls back to the last commit)", () => {
    const v = vaultFile();
    const { store } = v.open();
    store.applyEnvelopes(events());
    const hash = viewHash(store).hash;
    crash(store);
    const again = v.open();
    expect(again.recovered).toBe(false);
    expect(viewHash(again.store).hash).toBe(hash);
    again.store.close();
  });

  it("detects a torn page after a crash, starts a new database and rebuilds it by replay", () => {
    const v = vaultFile();
    const all = events();
    const { store } = v.open();
    store.applyEnvelopes(all);
    const hash = viewHash(store).hash;
    crash(store); // closing the last connection checkpoints the WAL into the main file
    const size = statSync(v.path).size;
    tear(v.path, Math.floor(size / 2 / 4096) * 4096, 3000); // a page torn from its header on
    const again = v.open();
    expect(again.recovered).toBe(true);
    expect(again.store.cursors().size).toBe(0); // the carrier replays from the start
    expect(again.store.read("SELECT COUNT(*) AS n FROM event_log")).toEqual([{ n: 0 }]);
    again.store.applyEnvelopes(all); // the replay
    expect(viewHash(again.store).hash).toBe(hash);
    again.store.close();
  });

  it("detects a database whose header is gone", () => {
    const v = vaultFile();
    const { store } = v.open();
    store.applyEnvelopes(events());
    store.close();
    tear(v.path, 0, 100);
    const again = v.open();
    expect(again.recovered).toBe(true);
    again.store.close();
  });
});
