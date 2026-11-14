import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import type { SqlDriver } from "../sql/driver.js";
import { SqlRecoveryCheckpointStore } from "./recoveryCheckpoint.js";

const A = "a".repeat(32);
const B = "b".repeat(32);
const drivers: SqlDriver[] = [];
afterEach(() => {
  for (const d of drivers.splice(0)) d.close();
});

function driver(): SqlDriver {
  const d = betterSqlite3Driver(new Database(":memory:"));
  drivers.push(d);
  return d;
}

describe("SqlRecoveryCheckpointStore", () => {
  it("keeps one row per device: load, replace, clear", () => {
    const d = driver();
    const a = new SqlRecoveryCheckpointStore(d, A);
    const b = new SqlRecoveryCheckpointStore(d, B);
    expect(a.load()).toBeUndefined();
    a.save("first");
    b.save("other device");
    a.save("second");
    expect(a.load()).toBe("second");
    expect(b.load()).toBe("other device");
    // A second instance over the same database (a new launch) reads the same row.
    expect(new SqlRecoveryCheckpointStore(d, A).load()).toBe("second");
    a.clear();
    expect(a.load()).toBeUndefined();
    expect(b.load()).toBe("other device");
    expect(d.prepare("SELECT COUNT(*) AS n FROM sync_recovery_checkpoint").get()).toEqual({ n: 1 });
  });

  it("a write inside a rolled-back transaction leaves the previous checkpoint", () => {
    const d = driver();
    const a = new SqlRecoveryCheckpointStore(d, A);
    a.save("kept");
    expect(() =>
      d.transaction(() => {
        a.save("lost");
        throw new Error("synthetic crash");
      }),
    ).toThrow("synthetic crash");
    expect(a.load()).toBe("kept");
  });
});
