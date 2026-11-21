// The store with the built-in modules over the production desktop driver (node:sqlite): the budget
// search index is an FTS5 virtual table (`budget.search`), so a runtime whose node:sqlite lacks FTS5
// must fail here, in CI, and never at a user's open. Node 24 (.nvmrc, CI, the Node of Electron) has
// it; an older Node's node:sqlite may not (Node 23.9: "no such module: fts5"), and only there the test
// is skipped, saying so. Synthetic data only.
import { DatabaseSync } from "node:sqlite";
import {
  builtinModules,
  createProfile,
  type EventWriter,
  HybridClock,
  runCommand,
  Store,
  vaultSalt,
} from "@cashu/store";
import { addCashExpense } from "@cashu/store/budget/commands";
import { budgetSearch } from "@cashu/store/budget/companion";
import { runQuery } from "@cashu/store/query";
import { describe, expect, it } from "vitest";
import { openNodeSqlite } from "./nodeSqlite.js";

function nodeSqliteHasFts5(): boolean {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE VIRTUAL TABLE probe USING fts5(text)");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
const SKIP = NODE_MAJOR < 24 && !nodeSqliteHasFts5();
if (SKIP) {
  console.warn(
    `nodeSqliteSearch.test.ts skipped: Node ${process.versions.node} node:sqlite has no FTS5 ` +
      "(the repo runs on Node 24 from .nvmrc, which has it)",
  );
}

describe("node:sqlite with the built-in modules", () => {
  it.skipIf(SKIP)("opens the store (FTS5 index included) and searches it", () => {
    const store = Store.open({
      driver: openNodeSqlite(":memory:"),
      vault: "5f0c3a9e81d24b7690ae13c7d2f4b856",
      salt: vaultSalt(new Uint8Array(32).fill(7)),
      modules: builtinModules(),
      companionReads: true,
    });
    try {
      const device = "e".repeat(32);
      const env = {
        device,
        clock: { now: () => Date.parse("2026-11-13T12:00:00Z") },
        hlc: new HybridClock(device),
        lease: { isHolder: () => true },
      };
      const writer: EventWriter = { append: (e) => store.applyEnvelopes(e) };
      const profile = runCommand(store, writer, createProfile, { slug: "demo", name: "Demo" }, env);
      expect(profile.ok).toBe(true);
      for (const [title, amount, onDate] of [
        ["Żabka Łódź", "12.50", "2026-11-01"],
        ["Kawa Orlen", "9.99", "2026-11-02"],
        ["Żabka Łódź", "14.00", "2026-11-03"],
      ] as const) {
        const added = runCommand(
          store,
          writer,
          addCashExpense,
          { amount, title, category: "groceries", currency: "PLN", onDate },
          env,
        );
        expect(added.ok).toBe(true);
      }
      const search = (q: string) => runQuery(store, budgetSearch, { q, lang: "pl" }).value;
      // prefix tokens, diacritics folded both ways, amounts, newest first
      expect(search("zabka").total).toBe(2);
      expect(search("ŁÓDŹ").rows.map((r) => r.date)).toEqual(["2026-11-03", "2026-11-01"]);
      expect(search("orl").total).toBe(1);
      expect(search("12,5").total).toBe(1);
      expect(search("zzqx").total).toBe(0);
    } finally {
      store.close();
    }
  });
});
