// The budget.search deriver and the engine's virtual-table rules on hand-made synthetic histories:
// every event applied alone (the incremental path) with the index recompute after each; a cash leg
// that appears and vanishes through account-only changes; a snapshot round trip; a rebuild, a
// version bump of the deriver (DROP of the virtual table) and a reset. Synthetic data only.
import { describe, expect, it } from "vitest";
import { formatHlc } from "../../events/v1/hlc-format.js";
import { builtinModules } from "../../modules.js";
import { runQuery } from "../../query.js";
import { exportSnapshot, importSnapshot, viewHash } from "../../snapshot.js";
import type { RefEvent } from "../../testing/scenario-bridge.js";
import { Names, toEnvelopes } from "../../testing/scenario-bridge.js";
import { complete, syntheticDet } from "../../testing/scenarios.js";
import { expectSearchIndexed, searchIndex } from "../../testing/search-oracle.js";
import {
  memoryDriver,
  openTestStore,
  TEST_SALT,
  TEST_VAULT,
  type TestEnvelope,
} from "../../testing/store.js";
import { bumpVersion } from "../../testing/upgrade.js";
import { budgetSearch, searchWords } from "../companion-queries.js";
import { ftsAmountPrefix, ftsAmountToken } from "./search.js";

type Spec = [type: string, gid: string, data: Record<string, unknown>];

const POOL = {
  bank: "manual",
  name: "Gotówka",
  externalId: "cash:PLN",
  type: "cash",
  keys: ["ext:manual:cash:PLN"],
};

function envelopes(specs: readonly Spec[]): TestEnvelope[] {
  const events: RefEvent[] = specs.map(([type, gid, data], i) =>
    complete({
      eid: `01JH${String(i + 1).padStart(22, "0")}`,
      hlc: formatHlc({ wall: 1_793_448_000_100 + i, counter: i, device: "a".repeat(32) }),
      at: new Date(1_793_448_000_100 + i).toISOString(),
      type,
      gid,
      data,
    }),
  );
  return toEnvelopes(events, new Names(), syntheticDet(events)) as TestEnvelope[];
}

const imported = (gid: string, hash: string, amount: string, name: string): Spec => [
  "txn.imported",
  gid,
  {
    account: "A1",
    dedupHash: hash,
    occurrence: 0,
    amount,
    bookingDate: `2026-10-0${hash.slice(1)}`,
    counterpartyName: name,
  },
];

/** A bank withdrawal claimed as cash, the pool opened, the account made a cash one (account-only). */
const HISTORY: readonly Spec[] = [
  ["account.opened", "A1", { externalId: "k1", keys: ["ext:mbank:k1"] }],
  imported("T-1", "h1", "-40.00", "BANKOMAT ŁÓDŹ"),
  imported("T-2", "h2", "-1284.00", "ORLEN STACJA"),
  imported("T-3", "h3", "-5.12", "Żabka Polska"),
  ["txn.categorySet", "T-1", { category: "cash_withdrawal", source: "manual_txn" }],
  // the pool opens: the leg appears through an account change alone
  ["account.opened", "pool:PLN", POOL],
  ["txn.categorySet", "T-2", { category: "fuel", source: "manual_txn" }],
  // the bank account turns into a cash account: the leg vanishes
  ["account.typeSet", "A1", { type: "cash" }],
];

const hits = (store: ReturnType<typeof openTestStore>, q: string) =>
  runQuery(store, budgetSearch, { q, lang: "pl" }).value.total;

describe("searchWords", () => {
  it("normalizes typed amounts to the index's numbers and keeps every other word", () => {
    expect(searchWords("1 284,00")).toEqual(["1284,00"]);
    expect(searchWords("12\u00a0500 zł")).toEqual(["12500"]);
    expect(searchWords("-12,50")).toEqual(["12,50"]);
    expect(searchWords("\u221212,50")).toEqual(["12,50"]);
    expect(searchWords("12,50 zł")).toEqual(["12,50"]);
    expect(searchWords("12,50zł orlen")).toEqual(["12,50", "orlen"]);
    expect(searchWords("orlen 1284")).toEqual(["orlen", "1284"]);
    // not a thousands grouping: two numbers stay two
    expect(searchWords("2025 100")).toEqual(["2025", "100"]);
    expect(searchWords("1 2345")).toEqual(["1", "2345"]);
    // a currency word without an amount is a plain word
    expect(searchWords("pln")).toEqual(["pln"]);
    expect(searchWords("  ")).toEqual([]);
  });
});

describe("budget.search deriver", () => {
  it("indexes every row, cash legs included, through account-only changes", () => {
    const store = openTestStore();
    try {
      const legs = () =>
        store.read<{ n: number }>(
          "SELECT count(*) AS n FROM transactions WHERE dedup_hash LIKE 'cashleg:%'",
        )[0]?.n;
      const seen: number[] = [];
      for (const e of envelopes(HISTORY)) {
        store.applyEnvelopes([e]);
        expectSearchIndexed(store);
        const incremental = searchIndex(store);
        store.rederive();
        expect(searchIndex(store)).toEqual(incremental);
        seen.push(legs() ?? 0);
      }
      // the leg came with the pool and went with the account type
      expect(seen).toEqual([0, 0, 0, 0, 0, 1, 1, 0]);
      expect(hits(store, "lodz")).toBe(1);
      expect(hits(store, "1284")).toBe(1);
      expect(hits(store, "zab")).toBe(1);
      // amounts as people type them (Polish thousands space, a sign, a currency)
      for (const q of [
        "1 284,00",
        "1\u00a0284",
        "-1284",
        "1284 zł",
        "1284zł",
        "orlen 1 284",
        "-5,12 PLN",
      ]) {
        expect(hits(store, q), q).toBe(1);
      }
      expect(hits(store, "1 285")).toBe(0);
    } finally {
      store.close();
    }
  });

  it("encodes amounts as one token, prefix-matched by a typed number", () => {
    expect(ftsAmountToken("-1284.00")).toBe("1284d00");
    expect(ftsAmountToken("12.5")).toBe("12d50");
    expect(ftsAmountToken("-0.123")).toBe("0d123");
    expect(ftsAmountToken("1E+3")).toBe("1000d00");
    expect(ftsAmountPrefix("1284")).toBe("1284");
    expect(ftsAmountPrefix("1284,5")).toBe("1284d5");
    expect(ftsAmountPrefix("007.10")).toBe("7d10");
    // zeros past the second decimal trimmed as the stored token trims them
    expect(ftsAmountPrefix("12.500")).toBe("12d50");
    expect(ftsAmountPrefix("12,5000")).toBe("12d50");
    expect(ftsAmountPrefix("12.000")).toBe("12d00");
    expect(ftsAmountPrefix("12.505")).toBe("12d505");
    expect(ftsAmountPrefix("12.0")).toBe("12d0");
    expect(ftsAmountToken("12.50").startsWith(ftsAmountPrefix("12.500"))).toBe(true);
  });

  it("is left out of snapshots and derived again on import (same hits)", () => {
    const store = openTestStore();
    try {
      store.applyEnvelopes(envelopes(HISTORY.slice(0, 7)));
      const snap = exportSnapshot(store);
      // the index, its memory and its env: all rebuilt by the deriver on import (one path)
      expect(Object.keys(snap.tables)).not.toContain("fold_txn_fts");
      expect(Object.keys(snap.tables)).not.toContain("fold_txn_fts_rows");
      expect(Object.keys(snap.tables)).not.toContain("fold_txn_fts_env");
      const copy = importSnapshot(
        {
          driver: memoryDriver(),
          vault: TEST_VAULT,
          salt: TEST_SALT,
          modules: builtinModules(),
          companionReads: true,
        },
        JSON.parse(JSON.stringify(snap)),
      );
      try {
        expect(viewHash(copy).hash).toBe(viewHash(store).hash);
        expect(searchIndex(copy)).toEqual(searchIndex(store));
        expect(copy.read("SELECT * FROM fold_txn_fts_rows ORDER BY leg, row")).toEqual(
          store.read("SELECT * FROM fold_txn_fts_rows ORDER BY leg, row"),
        );
        expectSearchIndexed(copy);
        for (const q of ["lodz", "orlen 1284", "żabka", "gotowka", "zz"]) {
          expect(runQuery(copy, budgetSearch, { q, lang: "pl" }).value).toEqual(
            runQuery(store, budgetSearch, { q, lang: "pl" }).value,
          );
        }
      } finally {
        copy.close();
      }
    } finally {
      store.close();
    }
  });

  it("survives a rebuild, a version bump (the virtual table dropped and created) and a reset", () => {
    const driver = memoryDriver();
    const store = openTestStore({ driver });
    store.applyEnvelopes(envelopes(HISTORY));
    const before = searchIndex(store);
    expect(before.length).toBeGreaterThan(0);
    store.rebuild();
    expect(searchIndex(store)).toEqual(before);
    store.detach();
    // a new deriver version: a partial upgrade drops and recreates its tables and runs deriveAll
    const bumped = openTestStore({
      driver,
      modules: bumpVersion(builtinModules(), "budget.search"),
    });
    try {
      expect(bumped.lastRebuild).toMatchObject({ scope: "partial" });
      expect(searchIndex(bumped)).toEqual(before);
      expectSearchIndexed(bumped);
      bumped.reset();
      expect(searchIndex(bumped)).toEqual([]);
      expect(hits(bumped, "orlen")).toBe(0);
    } finally {
      bumped.close();
    }
  });
});
