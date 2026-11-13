import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import type { SqlDriver } from "../sql/driver.js";
import { initializeMetaClockGuard, metaClockGuardStore } from "./clockGuard.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

function open(extra = ""): SqlDriver {
  const driver = betterSqlite3Driver(new Database(":memory:"));
  driver.exec(
    `CREATE TABLE store_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE event_log (hlc TEXT); CREATE TABLE sync_cursors (device TEXT); ${extra}`,
  );
  return driver;
}

const raw = (driver: SqlDriver, device: string) =>
  driver
    .prepare("SELECT value FROM store_meta WHERE key=?")
    .get<{ value: string }>(`fetch-clock-guard:${device}`)?.value;

it("requires explicit empty-view initialization and persists per-writer high watermarks", () => {
  const driver = open();
  try {
    const guard = metaClockGuardStore(driver, A);
    expect(() => guard.load()).toThrow("clock_guard_missing");
    initializeMetaClockGuard(driver, A);
    guard.save({ [B]: 500 });
    expect(metaClockGuardStore(driver, A).load()).toEqual({ [B]: 500 });
    expect(() => guard.save({ [B]: 499 })).toThrow("clock_guard_invalid");
    expect(() => guard.save({})).toThrow("clock_guard_invalid");
    driver.prepare("UPDATE store_meta SET value=? WHERE key=?").run("[]", `fetch-clock-guard:${A}`);
    expect(() => guard.load()).toThrow("clock_guard_corrupt");
    driver.prepare("UPDATE store_meta SET value=? WHERE key=?").run("{", `fetch-clock-guard:${A}`);
    expect(() => guard.load()).toThrow("clock_guard_corrupt");
  } finally {
    driver.close();
  }
});

it("keeps the persisted key and JSON bytes of existing vaults", () => {
  const driver = open();
  try {
    initializeMetaClockGuard(driver, A);
    expect(raw(driver, A)).toBe("{}");
    metaClockGuardStore(driver, A).save({ [B]: 1_700_000_000_000, [C]: 7 });
    expect(raw(driver, A)).toBe(
      '{"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":1700000000000,"cccccccccccccccccccccccccccccccc":7}',
    );
    // A row written by the host's former nativeClockGuard reads back unchanged.
    driver
      .prepare("UPDATE store_meta SET value=? WHERE key=?")
      .run('{"cccccccccccccccccccccccccccccccc":9}', `fetch-clock-guard:${A}`);
    expect(metaClockGuardStore(driver, A).load()).toEqual({ [C]: 9 });
  } finally {
    driver.close();
  }
});

it("refuses an invalid device id and empty initialization after history exists", () => {
  const cursor = open("INSERT INTO sync_cursors VALUES ('x')");
  const event = open("INSERT INTO event_log VALUES ('h')");
  try {
    expect(() => metaClockGuardStore(cursor, "A".repeat(32))).toThrow("clock_guard_invalid");
    expect(() => initializeMetaClockGuard(cursor, "x")).toThrow("clock_guard_invalid");
    expect(() => initializeMetaClockGuard(cursor, A)).toThrow("clock_guard_existing_history");
    expect(() => initializeMetaClockGuard(event, A)).toThrow("clock_guard_existing_history");
    expect(() => metaClockGuardStore(cursor, A).load()).toThrow("clock_guard_missing");
  } finally {
    cursor.close();
    event.close();
  }
});
