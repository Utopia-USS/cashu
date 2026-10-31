// The expo-sqlite adapter against a stand-in with expo-sqlite 58's synchronous semantics, built on
// better-sqlite3: `executeSync` resets the statement and steps it once, rows come back as objects with
// blobs as plain Uint8Array, and a stepped row read keeps its cursor open until the next run or
// `resetSync`. better-sqlite3 refuses any other statement on the connection while a read is open, so
// an adapter that forgets to reset a cursor fails here. The device run (apps/mobile, S41) checks the
// real module.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { delivery, SCENARIOS, syntheticDet } from "../events/v1/reference/testing/scenarios.js";
import { viewHash } from "../snapshot.js";
import { Names, toEnvelopes } from "../testing/reference-bridge.js";
import { openTestStore } from "../testing/store.js";
import { type ExpoSqliteDatabase, expoSqliteDriver } from "./expo-sqlite.js";

const plain = (row: unknown): unknown => {
  if (row === undefined || row === null) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[k] = v instanceof Uint8Array ? Uint8Array.from(v) : v;
  }
  return out;
};

/** expo-sqlite's sync API on better-sqlite3 (one connection, one cursor per statement). */
function expoLike(db: Database.Database): ExpoSqliteDatabase & { finalized: number } {
  const handle = {
    finalized: 0,
    execSync(sql: string) {
      db.exec(sql);
    },
    prepareSync(sql: string) {
      const stmt = db.prepare(sql);
      let cursor: IterableIterator<unknown> | undefined;
      const reset = () => {
        cursor?.return?.();
        cursor = undefined;
      };
      return {
        executeSync(params: unknown[]) {
          reset(); // exsqlite3_reset + rebind
          if (!stmt.reader) {
            const r = stmt.run(...params);
            const done = () => [] as unknown[];
            return {
              changes: r.changes,
              lastInsertRowId: Number(r.lastInsertRowid),
              getFirstSync: () => null,
              getAllSync: done,
              resetSync: reset,
            };
          }
          const it = stmt.iterate(...params);
          cursor = it;
          const first = it.next(); // the native run steps once
          let stepped = false;
          if (first.done) cursor = undefined;
          return {
            changes: 0,
            lastInsertRowId: 0,
            getFirstSync() {
              if (stepped) throw new Error("The SQLite cursor has been shifted");
              stepped = true;
              return first.done ? null : plain(first.value);
            },
            getAllSync() {
              if (stepped) throw new Error("The SQLite cursor has been shifted");
              stepped = true;
              if (first.done) return [];
              const rows = [plain(first.value)];
              for (const row of it) rows.push(plain(row));
              cursor = undefined;
              return rows;
            },
            resetSync: reset,
          };
        },
        finalizeSync() {
          reset();
          handle.finalized += 1;
        },
      };
    },
    withTransactionSync(task: () => void) {
      // expo-sqlite 58: BEGIN, task, COMMIT; ROLLBACK on a throw.
      db.exec("BEGIN");
      try {
        task();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    closeSync() {
      db.close();
    },
  };
  return handle;
}

describe("expoSqliteDriver", () => {
  it("runs, reads one row, reads all rows and round-trips blobs and big integers", () => {
    const driver = expoSqliteDriver(expoLike(new Database(":memory:")));
    driver.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER, b BLOB)");
    const insert = driver.prepare("INSERT INTO t (n, b) VALUES (?, ?)");
    expect(insert.run(1, Uint8Array.of(1, 2, 3))).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(insert.run(2n ** 40n, null).lastInsertRowid).toBe(2);
    const one = driver.prepare("SELECT n, b FROM t WHERE id = ?");
    expect(one.get(1)).toEqual({ n: 1, b: Uint8Array.of(1, 2, 3) });
    expect(one.get(2)).toEqual({ n: 2 ** 40, b: null });
    expect(one.get(3)).toBeUndefined();
    expect(driver.prepare("SELECT n FROM t ORDER BY id").all()).toEqual([{ n: 1 }, { n: 2 ** 40 }]);
  });

  it("leaves no read open after get: a write on the same connection follows", () => {
    const driver = expoSqliteDriver(expoLike(new Database(":memory:")));
    driver.exec("CREATE TABLE t (n INTEGER)");
    driver.exec("INSERT INTO t VALUES (1), (2)");
    const first = driver.prepare("SELECT n FROM t ORDER BY n");
    expect(first.get()).toEqual({ n: 1 });
    expect(() => driver.prepare("INSERT INTO t VALUES (3)").run()).not.toThrow();
  });

  it("nests transactions with savepoints and rolls back only the inner one", () => {
    const driver = expoSqliteDriver(expoLike(new Database(":memory:")));
    driver.exec("CREATE TABLE t (n INTEGER)");
    const insert = driver.prepare("INSERT INTO t VALUES (?)");
    driver.transaction(() => {
      insert.run(1);
      expect(() =>
        driver.transaction(() => {
          insert.run(2);
          throw new Error("inner");
        }),
      ).toThrow("inner");
      insert.run(3);
    });
    expect(() =>
      driver.transaction(() => {
        insert.run(4);
        throw new Error("outer");
      }),
    ).toThrow("outer");
    expect(driver.prepare("SELECT n FROM t ORDER BY n").all()).toEqual([{ n: 1 }, { n: 3 }]);
  });

  it("finalizes its statements on close", () => {
    const db = expoLike(new Database(":memory:"));
    const driver = expoSqliteDriver(db);
    driver.prepare("SELECT 1").get();
    driver.prepare("SELECT 2").all();
    driver.close();
    expect(db.finalized).toBe(2);
  });

  describe("the store on it builds the same view as on better-sqlite3", () => {
    it.each(SCENARIOS.map((s) => [`${s.group}: ${s.name}`, s] as const))("%s", (_name, s) => {
      const det = syntheticDet(s.events);
      const envelopes = delivery(toEnvelopes(s.events, new Names(), det), 1);
      const expo = openTestStore({ driver: expoSqliteDriver(expoLike(new Database(":memory:"))) });
      const node = openTestStore();
      expo.applyEnvelopes(envelopes);
      node.applyEnvelopes(envelopes);
      const hash = viewHash(node).hash;
      expect(viewHash(expo).hash).toBe(hash);
      expo.rebuild({ redecode: true, reindex: true });
      expect(viewHash(expo).hash).toBe(hash);
      expo.close();
      node.close();
    });
  });
});
