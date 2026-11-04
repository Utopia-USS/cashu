// The node:sqlite SqlDriver on a temp database: read-write basics (transactions, savepoints,
// rollback) and the read-only mode a host uses on a live WAL database written by another connection.
import { lstatSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireHostLock } from "./host/lock.js";
import { backupNodeSqlite, openNodeSqlite, ReadOnlyDriverError } from "./nodeSqlite.js";

const tempDb = () => join(mkdtempSync(join(tmpdir(), "cashu-node-host-sqlite-")), "t.db");

const count = (db: ReturnType<typeof openNodeSqlite>) =>
  db.prepare("SELECT count(*) AS n FROM t").get<{ n: number }>()?.n;

describe("node:sqlite driver, read-write", () => {
  it("creates, writes and reads with numbers for integers and caches statements", () => {
    const db = openNodeSqlite(tempDb());
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, b BLOB)");
    const insert = db.prepare("INSERT INTO t (v, b) VALUES (?, ?)");
    expect(insert.run("a", Uint8Array.of(1, 2))).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(db.prepare("INSERT INTO t (v, b) VALUES (?, ?)")).toBe(insert);
    const row = db
      .prepare("SELECT id, v, b FROM t")
      .get<{ id: number; v: string; b: Uint8Array }>();
    expect(row?.id).toBe(1);
    expect(row?.v).toBe("a");
    expect([...(row?.b ?? [])]).toEqual([1, 2]);
    db.close();
  });

  it("commits a transaction, rolls back on a throw, and nests as savepoints", () => {
    const db = openNodeSqlite(":memory:");
    db.exec("CREATE TABLE t (v TEXT)");
    const insert = db.prepare("INSERT INTO t (v) VALUES (?)");
    db.transaction(() => insert.run("kept"));
    expect(() =>
      db.transaction(() => {
        insert.run("lost");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(count(db)).toBe(1);
    db.transaction(() => {
      insert.run("outer");
      expect(() =>
        db.transaction(() => {
          insert.run("inner");
          throw new Error("inner");
        }),
      ).toThrow("inner");
    });
    expect(
      db
        .prepare("SELECT v FROM t ORDER BY rowid")
        .all<{ v: string }>()
        .map((r) => r.v),
    ).toEqual(["kept", "outer"]);
    db.close();
  });
});

describe("node:sqlite driver, read-only", () => {
  function walWriter() {
    const path = tempDb();
    const writer = openNodeSqlite(path);
    writer.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT)");
    writer.prepare("INSERT INTO t (v) VALUES (?)").run("one");
    return { path, writer };
  }

  it("refuses exec and run up front, and SQLite refuses a write slipped through get", () => {
    const { path, writer } = walWriter();
    const reader = openNodeSqlite(path, { readOnly: true });
    expect(() => reader.exec("DELETE FROM t")).toThrow(ReadOnlyDriverError);
    expect(() => reader.prepare("DELETE FROM t").run()).toThrow(ReadOnlyDriverError);
    expect(() => reader.prepare("DELETE FROM t RETURNING v").get()).toThrow(/readonly/i);
    expect(count(reader)).toBe(1);
    reader.close();
    writer.close();
  });

  it("reads a live WAL database: one snapshot per transaction, the latest commit outside", () => {
    const { path, writer } = walWriter();
    const reader = openNodeSqlite(path, { readOnly: true });
    const insert = writer.prepare("INSERT INTO t (v) VALUES (?)");
    const seen = reader.transaction(() => {
      const before = count(reader);
      insert.run("two"); // another connection commits while the read transaction is open
      return [before, count(reader)];
    });
    expect(seen).toEqual([1, 1]);
    expect(count(reader)).toBe(2);
    // The read transaction ended: the writer can checkpoint the whole WAL.
    const checkpoint = writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get<{ busy: number }>();
    expect(checkpoint?.busy).toBe(0);
    reader.close();
    writer.close();
  });

  it("does not create a missing file", () => {
    expect(() => openNodeSqlite(tempDb(), { readOnly: true })).toThrow();
  });
});

describe("live exclusive online backup", () => {
  it("captures committed WAL through the held writer and refuses a stale or ordinary driver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cashu-node-backup-"));
    const lock = acquireHostLock(join(dir, "host.lock.db"));
    if (!lock) throw new Error("synthetic lock unavailable");
    const source = openNodeSqlite(join(dir, "source.db"), { exclusive: lock });
    try {
      source.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE t(v TEXT)");
      source.prepare("INSERT INTO t(v) VALUES (?)").run("synthetic");
      const destination = join(dir, "copy.db");
      await backupNodeSqlite(source, destination);
      expect(lstatSync(destination).mode & 0o777).toBe(0o600);
      const copy = openNodeSqlite(destination, { readOnly: true });
      try {
        expect(copy.prepare("SELECT v FROM t").get()).toEqual({ v: "synthetic" });
      } finally {
        copy.close();
      }
      const ordinary = openNodeSqlite(":memory:");
      try {
        await expect(backupNodeSqlite(ordinary, join(dir, "other.db"))).rejects.toThrow();
      } finally {
        ordinary.close();
      }
    } finally {
      source.close();
      lock.release();
    }
    await expect(backupNodeSqlite(source, join(dir, "late.db"))).rejects.toThrow();
  });
});
