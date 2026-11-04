import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { expect, it } from "vitest";
import { initializeNativeClockGuard, nativeClockGuard } from "./clockGuard.js";

const A = "a".repeat(32);
const B = "b".repeat(32);

it("requires explicit empty-view initialization and persists per-writer high watermarks", () => {
  const driver = openNodeSqlite(":memory:");
  try {
    driver.exec(
      "CREATE TABLE store_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE event_log (hlc TEXT); CREATE TABLE sync_cursors (device TEXT)",
    );
    const guard = nativeClockGuard(driver, A);
    expect(() => guard.load()).toThrow("market_clock_guard_missing");
    initializeNativeClockGuard(driver, A);
    guard.save({ [B]: 500 });
    expect(nativeClockGuard(driver, A).load()).toEqual({ [B]: 500 });
    expect(() => guard.save({ [B]: 499 })).toThrow("market_clock_guard_invalid");
    driver.prepare("UPDATE store_meta SET value=? WHERE key=?").run("[]", `fetch-clock-guard:${A}`);
    expect(() => guard.load()).toThrow("market_clock_guard_corrupt");
  } finally {
    driver.close();
  }
});

it("refuses empty initialization after a cursor advanced", () => {
  const driver = openNodeSqlite(":memory:");
  try {
    driver.exec(
      "CREATE TABLE store_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE event_log (hlc TEXT); CREATE TABLE sync_cursors (device TEXT); INSERT INTO sync_cursors VALUES ('x')",
    );
    expect(() => initializeNativeClockGuard(driver, A)).toThrow(
      "market_clock_guard_existing_history",
    );
    expect(() => nativeClockGuard(driver, A).load()).toThrow("market_clock_guard_missing");
  } finally {
    driver.close();
  }
});
