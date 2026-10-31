// The demo log on the real store over better-sqlite3 (Node): every event valid, duplicates are
// no-ops, rebuild == incremental apply. `PRINT_DEMO_HASH=1` prints the view hash for the device check.
import { betterSqlite3Driver, builtinModules, Store } from "@cashu/store";
import Database from "better-sqlite3";
import { DEMO_SALT, DEMO_VAULT, demoLog } from "./demoLog";
import { loadDemo } from "./loadDemo";

function openMemoryStore(): Store {
  return Store.open({
    driver: betterSqlite3Driver(new Database(":memory:")),
    vault: DEMO_VAULT,
    salt: DEMO_SALT,
    modules: builtinModules(),
  });
}

describe("demo log", () => {
  it("is deterministic", () => {
    expect(JSON.stringify(demoLog())).toBe(JSON.stringify(demoLog()));
  });

  it("builds the pinned view, and a rebuild from the log gives the same view", () => {
    const store = openMemoryStore();
    const r = loadDemo(store, () => 0);
    expect(r.rejected).toBe(0);
    expect(r.parked).toBe(0);
    // Re-exported facts carry new eids: stored, folded, no new rows (CREATE keeps the first).
    expect(r.duplicates).toBe(0);
    expect(r.applied).toBe(r.events);
    expect(r.hashAfterRebuild).toBe(r.hashAfterApply);
    expect(r.rebuildMatches).toBe(true);
    if (process.env.PRINT_DEMO_HASH === "1") console.log(`DEMO_VIEW_HASH_NODE=${r.hashAfterApply}`);
    const rows = Object.fromEntries(r.tables.map((t) => [t.table, t.rows]));
    expect(rows.accounts).toBe(4);
    expect(rows.transactions).toBe(12 * 195);
    // Re-delivery of held eids is a no-op.
    const again = store.applyEnvelopes(demoLog().slice(0, 500));
    expect(again.duplicates).toBe(500);
    expect(again.applied).toBe(0);
    store.close();
  });
});
