import { spawnSync } from "node:child_process";
import { lstatSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExclusiveOpenError, openNodeSqlite } from "../nodeSqlite.js";
import { cleanup, tempDir, trackDir } from "../testing/hostHarness.js";
import { acquireHostLock, HostLock } from "./lock.js";

afterEach(cleanup);

/** Another process opens `path` and reads it, as a stray second writer would. */
function foreignRead(path: string): string {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    try {
      const db = new DatabaseSync(${JSON.stringify(path)});
      db.exec("PRAGMA busy_timeout = 0");
      db.prepare("SELECT count(*) AS c FROM sqlite_master").get();
      console.log("opened");
    } catch (e) { console.log(e.message); }`;
  const r = spawnSync(process.execPath, ["--no-warnings", "-e", script], { encoding: "utf8" });
  return r.stdout.trim();
}

describe("host lock", () => {
  it("admits one holder; release lets the next one in", () => {
    const dir = trackDir(tempDir());
    const path = join(dir, "host.lock.db");
    const first = acquireHostLock(path);
    expect(first).toBeInstanceOf(HostLock);
    expect(acquireHostLock(path)).toBeUndefined();
    expect(foreignRead(path)).toBe("database is locked");
    first?.release();
    first?.release();
    expect(first?.held).toBe(false);
    const second = acquireHostLock(path);
    expect(second?.held).toBe(true);
    second?.release();
  });

  it("cannot be forged", () => {
    const Forged = HostLock as unknown as new (k: symbol, p: string, d: unknown) => HostLock;
    expect(() => new Forged(Symbol("HostLock"), "x", undefined)).toThrow(TypeError);
  });

  it("creates private lock bytes and invalidates a replaced lock path", () => {
    const dir = trackDir(tempDir());
    const path = join(dir, "host.lock.db");
    const lock = acquireHostLock(path);
    if (!lock) throw new Error("lock");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(`${path}-journal`).mode & 0o777).toBe(0o600);
    renameSync(path, `${path}.moved`);
    writeFileSync(path, "replacement", { mode: 0o600 });
    expect(lock.held).toBe(false);
    lock.release();
  });

  it("refuses an existing symlink lock path", () => {
    const dir = trackDir(tempDir());
    writeFileSync(join(dir, "target"), "synthetic", { mode: 0o600 });
    symlinkSync(join(dir, "target"), join(dir, "host.lock.db"));
    expect(() => acquireHostLock(join(dir, "host.lock.db"))).toThrow("host_lock_path_invalid");
  });
});

describe("exclusive writer open", () => {
  it("refuses another process's open of a vault DB while the host holds it", () => {
    const dir = trackDir(tempDir());
    const lock = acquireHostLock(join(dir, "host.lock.db"));
    if (lock === undefined) throw new Error("lock");
    const vault = join(dir, "vault.db");
    const db = openNodeSqlite(vault, { exclusive: lock });
    expect(foreignRead(vault)).toBe("database is locked");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE t(a); INSERT INTO t VALUES (1)");
    expect(foreignRead(vault)).toBe("database is locked");
    db.close();
    expect(foreignRead(vault)).toBe("opened");
    // Reopening an existing WAL database exclusively locks it at once too.
    const again = openNodeSqlite(vault, { exclusive: lock });
    expect(foreignRead(vault)).toBe("database is locked");
    expect(again.prepare("SELECT a FROM t").get()).toEqual({ a: 1 });
    again.close();
    lock.release();
  });

  it("requires the held host lock and a writable open", () => {
    const dir = trackDir(tempDir());
    const lock = acquireHostLock(join(dir, "host.lock.db"));
    if (lock === undefined) throw new Error("lock");
    expect(() => openNodeSqlite(join(dir, "v.db"), { exclusive: lock, readOnly: true })).toThrow(
      ExclusiveOpenError,
    );
    lock.release();
    expect(() => openNodeSqlite(join(dir, "v.db"), { exclusive: lock })).toThrow(/not held/);
  });
});
