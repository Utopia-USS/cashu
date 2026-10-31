// S26 spec 10 `genesis.test.ts`, 8.4, 7, 4.7: end to end on a synthetic two-profile Python database
// (every table genesis reads, schemas 0025 / 0026 / 0028): every event parses, every payload-derived
// gid equals DET(detPartsOf), the logs fold into fresh stores without parking, rejects, suppression
// or account conflicts, view row counts equal the source, two runs are byte-identical, 0025 == 0026,
// profiles stay apart, and the signals of one key are emitted closed-first. Synthetic only.
import { describe, expect, it } from "vitest";
import { parseEvent } from "../events/v1/catalog.js";
import { detPartsOf } from "../events/v1/det-parts.js";
import { fromWire } from "../events/v1/envelope.js";
import { detGid } from "../gid.js";
import { Store } from "../materialize.js";
import { builtinModules } from "../modules.js";
import { memoryDriver, openTestStore, TEST_VAULT } from "../testing/store.js";
import { GENESIS_CHUNK, type GenesisResult, type GenesisVault, genesis } from "./index.js";
import { FILES, KEYS, NOW, seededDb } from "./testing/genesisData.js";

const run = (schema: "0025" | "0026" | "0028" = "0026"): GenesisResult =>
  genesis({ driver: seededDb(schema), files: FILES }, KEYS, { strict: true, now: NOW });

function keysOf(v: GenesisVault) {
  const keys = [...KEYS.values()].find((k) => k.vault === v.vault);
  if (keys === undefined) throw new Error("no keys for the vault");
  return keys;
}

function fold(v: GenesisVault): Store {
  const keys = keysOf(v);
  const store =
    v.vault === TEST_VAULT
      ? openTestStore()
      : Store.open({
          driver: memoryDriver(),
          vault: v.vault,
          salt: keys.salt,
          modules: builtinModules(),
        });
  for (let i = 0; i < v.events.length; i += GENESIS_CHUNK) {
    const r = store.applyWire({ device: v.device, events: v.events.slice(i, i + GENESIS_CHUNK) });
    expect([r.parked, r.suppressed, r.rejected, r.conflicts, r.needsUpgrade]).toEqual([
      0,
      0,
      [],
      [],
      false,
    ]);
  }
  return store;
}

const count = (store: Store, table: string) =>
  store.read<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n;

describe("genesis end to end", () => {
  const result = run();
  const [anna, piotr] = result.vaults;

  it("exports both profiles by ordinal, every event valid, every DET gid from its parts", () => {
    expect(result.vaults.map((v) => [v.ordinal, v.profileId, v.vault])).toEqual([
      [0, 1, TEST_VAULT],
      [1, 2, "7".repeat(32)],
    ]);
    for (const v of result.vaults) {
      const salt = keysOf(v).salt;
      for (const w of v.events) {
        const parsed = parseEvent(fromWire(w, { vault: v.vault, device: v.device }));
        expect(parsed.status, w.t).toBe("known");
        const parts = detPartsOf(w.t, w.d);
        if (parts !== undefined) expect(detGid(salt, parts.table, parts.parts), w.t).toBe(w.g);
        expect(w.o).toBe("genesis");
      }
      expect(v.lines.join("")).toMatch(/^(\{.*\}\n)+$/);
    }
    expect(Object.keys(result.report.vaults[0]?.byType ?? {})).toEqual([
      "account.opened",
      "account.removed",
      "alert.created",
      "alert.deleted",
      "alert.evaluated",
      "alert.statusSet",
      "assetDetails.noteSet",
      "balance.recorded",
      "budgetSettings.cushionSet",
      "categoryRule.set",
      "connectorBinding.cursorAdvanced",
      "connectorBinding.set",
      "decision.recorded",
      "depreciation.set",
      "importBatch.recorded",
      "instrument.aliasAdded",
      "instrument.created",
      "instrumentOverride.planSet",
      "instrumentOverride.segmentSet",
      "instrumentOverride.set",
      "instrumentRename.recorded",
      "invAccount.settingsSet",
      "invImport.recorded",
      "invTxn.imported",
      "loan.paymentMatchingSet",
      "loan.termsSet",
      "module.disabled",
      "module.enabled",
      "note.added",
      "note.dismissed",
      "note.read",
      "plannedDeposit.booked",
      "plannedDeposit.cancelled",
      "plannedDeposit.created",
      "position.snapshotImported",
      "profile.created",
      "proposal.approved",
      "proposal.created",
      "researchRun.finished",
      "researchRun.started",
      "review.done",
      "ruleRun.finished",
      "signal.closed",
      "signal.opened",
      "signal.refreshed",
      "signal.snoozed",
      "strategy.versionSaved",
      "thesis.created",
      "topicThesis.draftProposed",
      "topicThesis.marketViewSet",
      "topicThesis.ownerSaved",
      "topicThesis.rejected",
      "txn.cashExpenseAdded",
      "txn.categorySet",
      "txn.imported",
      "valuation.set",
      "watchlist.added",
      "watchlist.removed",
    ]);
  });

  it("counts every documented skip and side-file case, never a value", () => {
    const v0 = result.report.counters.vaults["0"] ?? {};
    expect(v0.inv_instruments?.instrument_orphan).toBe(1);
    expect(v0.budget_settings?.dangling_account_ids).toBe(1);
    expect(v0.inv_rule_runs?.report_lists_filled).toBe(1);
    expect(v0.research_runs?.run_running).toBe(1);
    expect(v0.transactions?.raw_null_as_object).toBe(2);
    expect(result.report.vaults[0]?.files).toEqual({});
    expect(result.report.vaults[0]?.fk).toEqual({ "budget_settings.dangling_account_ids": 1 });
    const text = JSON.stringify(result.report);
    for (const secret of ["anna", "Anna", "piotr", "Sklep", "PL61"])
      expect(text).not.toContain(secret);
  });

  it("seeds sync_ids for exported rows and keeps device-local state out of the log", () => {
    const ids = anna?.ids ?? [];
    expect(ids).toContainEqual({ table: "profiles", localId: "1", gid: TEST_VAULT });
    expect(ids.filter((e) => e.table === "profile_modules").map((e) => e.localId)).toEqual([
      "1|budget",
      "1|investments",
      "1|loans",
    ]);
    expect(ids.some((e) => e.table === "inv_decision_signals")).toBe(false);
    expect(ids.filter((e) => e.table === "transactions").map((e) => e.localId)).toEqual([
      "1",
      "2",
      "3",
      "5",
    ]);
    expect(ids.filter((e) => e.table === "inv_instruments").map((e) => e.localId)).toEqual([
      "1",
      "2",
      "3",
    ]);
    const signal = ids.find((e) => e.table === "inv_signals" && e.localId === "1")?.gid;
    const binding = ids.find((e) => e.table === "connector_bindings")?.gid;
    expect(anna?.deviceLocal.notifications.map((n) => n.signal)).toEqual([signal]);
    expect(anna?.deviceLocal.connectorFetch.map((c) => [c.binding, c.lastStatus])).toEqual([
      [binding, "ok"],
    ]);
    expect(anna?.lines.join("")).not.toContain("macos");
    expect(piotr?.ids.filter((e) => e.table === "inv_instruments").map((e) => e.localId)).toEqual([
      "1",
    ]);
  });

  it("stamps the row's updated_at on alert.statusSet (the S25 fold bumps it there)", () => {
    const stampOf = (w: { d: Record<string, unknown> }) =>
      (w.d.stamps as Record<string, unknown> | undefined)?.updated_at;
    let checked = 0;
    for (const v of result.vaults) {
      const created = new Map(
        v.events.filter((w) => w.t === "alert.created").map((w) => [w.g, stampOf(w)]),
      );
      for (const w of v.events.filter((e) => e.t === "alert.statusSet")) {
        expect(stampOf(w)).toBeTypeOf("string");
        expect(stampOf(w)).toBe(created.get(w.g));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("folds into fresh stores: nothing parked, view rows equal the source (spec 8.4)", () => {
    const expected: Record<string, [number, number]> = {
      accounts: [6, 1],
      category_rules: [1, 1],
      // Source rows minus the documented skip: the cash leg is DERIVED (no event); the cash
      // expense folds through S24a's `txn.cashExpenseAdded`.
      transactions: [4, 1],
      watchlist_items: [2, 1],
      inv_profile_instruments: [1, 0],
      inv_manual_valuations: [1, 0],
      inv_signals: [4, 0],
      inv_decisions: [1, 0],
      inv_decision_signals: [2, 0],
      proposals: [2, 0],
      connector_bindings: [1, 0],
    };
    for (const v of result.vaults) {
      const store = fold(v);
      expect(store.needsUpgrade()).toBe(false);
      expect(count(store, "unknown_events")).toBe(0);
      expect(count(store, "account_conflicts")).toBe(0);
      const counts = Object.fromEntries(Object.keys(expected).map((t) => [t, count(store, t)]));
      const want = Object.fromEntries(Object.entries(expected).map(([t, n]) => [t, n[v.ordinal]]));
      expect(counts).toEqual(want);
      const again = store.applyWire({ device: v.device, events: v.events });
      expect([again.applied, again.duplicates]).toEqual([0, v.events.length]);
    }
  });
});

describe("genesis determinism and isolation", () => {
  it("is byte-identical across runs and across schemas 0025 / 0026 / 0028 (spec 7, G7)", () => {
    const a = run("0026");
    const b = run("0026");
    expect(a.vaults.map((v) => v.lines)).toEqual(b.vaults.map((v) => v.lines));
    const shas = (r: GenesisResult) => r.vaults.map((v) => v.logSha256);
    expect(shas(run("0025"))).toEqual(shas(a));
    expect(shas(run("0028"))).toEqual(shas(a));
    expect(shas(a)[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the profiles apart: no gid or value of one vault in the other", () => {
    const [anna, piotr] = run().vaults;
    const GID = /[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;
    const gids = (v: GenesisVault | undefined) => new Set(v?.lines.join("").match(GID) ?? []);
    const annaGids = gids(anna);
    expect([...gids(piotr)].filter((g) => annaGids.has(g))).toEqual([]);
    const piotrLog = piotr?.lines.join("") ?? "";
    for (const value of ["Anna Syntetyczna", "SKLEP", "Obiad", "Auto testowe", TEST_VAULT]) {
      expect(piotrLog).not.toContain(value);
    }
  });
});
