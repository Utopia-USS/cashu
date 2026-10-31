// The node:sqlite driver runs the real store: open, commands, live queries, nested transactions.
// Synthetic data, in-memory databases only.
import {
  builtinModules,
  createProfile,
  HybridClock,
  renameProfile,
  runCommand,
  Store,
  storeWriter,
  vaultSalt,
} from "@cashu/store";
import { profile } from "@cashu/store/core";
import { watchQuery } from "@cashu/store/query";
import { describe, expect, it } from "vitest";
import { openNodeSqlite } from "./nodeSqlite.js";

const VAULT = "0123456789abcdef0123456789abcdef";
const DEVICE = "dddddddddddddddddddddddddddddddd";

describe("node:sqlite driver", () => {
  it("runs the store: commands apply and live queries follow", () => {
    const store = Store.open({
      driver: openNodeSqlite(":memory:"),
      vault: VAULT,
      salt: vaultSalt(new Uint8Array(32).fill(7)),
      modules: builtinModules(),
    });
    let now = 1_793_448_000_000;
    const clock = { now: () => (now += 1) };
    const env = {
      device: DEVICE,
      clock,
      hlc: new HybridClock(DEVICE, { physical: clock }),
      lease: { isHolder: () => true },
    };
    const names: (string | null)[] = [];
    watchQuery(store, profile, undefined, {
      onValue: (p) => names.push(p?.name ?? null),
      onError: (e) => {
        throw e;
      },
    });
    const writer = storeWriter(store);
    expect(runCommand(store, writer, createProfile, { slug: "d", name: "Demo" }, env).ok).toBe(
      true,
    );
    expect(runCommand(store, writer, renameProfile, { name: "Demo 2" }, env).ok).toBe(true);
    expect(names).toEqual([null, "Demo", "Demo 2"]);
    store.close();
  });

  it("rolls back a failed nested transaction to its savepoint only", () => {
    const driver = openNodeSqlite(":memory:");
    driver.exec("CREATE TABLE t (v INTEGER)");
    driver.transaction(() => {
      driver.prepare("INSERT INTO t (v) VALUES (?)").run(1);
      expect(() =>
        driver.transaction(() => {
          driver.prepare("INSERT INTO t (v) VALUES (?)").run(2);
          throw new Error("inner");
        }),
      ).toThrow("inner");
    });
    expect(driver.prepare("SELECT v FROM t").all()).toEqual([{ v: 1 }]);
    expect(() =>
      driver.transaction(() => {
        driver.prepare("INSERT INTO t (v) VALUES (?)").run(3);
        throw new Error("outer");
      }),
    ).toThrow("outer");
    expect(driver.prepare("SELECT COUNT(*) AS n FROM t").get()).toEqual({ n: 1 });
    driver.close();
  });
});
