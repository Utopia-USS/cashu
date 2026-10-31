// S26 spec 4.7 / events.md 11 (signal order), 4 "--strict", 6.5 guard, gid.md 7.1 / 7.5: the
// convergence-critical signal order scenario (an old reopened signal and a newer closed one of the
// same key) and the refusals of the public API, strict and lenient. Synthetic only.
import { describe, expect, it } from "vitest";
import type { WireEvent } from "../events/v1/envelope.js";
import { openTestStore, TEST_SALT, TEST_VAULT } from "../testing/store.js";
import { GenesisError, genesis, type VaultKeys } from "./index.js";
import { NOW } from "./testing/genesisData.js";
import { NO_FILES } from "./testing/phase1.js";
import { PythonRows } from "./testing/pythonRows.js";
import { pythonDb } from "./testing/pythonSchema.js";

const KEYS: ReadonlyMap<string, VaultKeys> = new Map([
  ["anna", { vault: TEST_VAULT, salt: TEST_SALT }],
]);
const T0 = "2026-01-02 03:04:05.000000";
const T1 = "2026-02-03 04:05:06.000000";

function db() {
  const driver = pythonDb();
  const rows = new PythonRows(driver);
  rows.insert("profiles", {});
  return { driver, rows };
}

const ALERT = { scope: "portfolio", polarity: "negative", source: "user", created_by: "app" };

function errorOf(fn: () => unknown): GenesisError {
  try {
    fn();
  } catch (e) {
    if (e instanceof GenesisError) return e;
    throw e;
  }
  throw new Error("expected a GenesisError");
}

describe("signal emission order (spec 4.7)", () => {
  it("emits the closed signals of a key first, so the reopened older one stays open", () => {
    const { driver, rows } = db();
    const signal = { kind: "drawdown", rule_id: "rule_x", dedup_key: "rule_x" };
    const reopened = rows.insert("inv_signals", { ...signal, first_seen_at: T0 });
    const closed = rows.insert("inv_signals", { ...signal, status: "resolved", closed_at: T1 });
    const other = rows.insert("inv_signals", { ...signal, rule_id: "rule_y", dedup_key: "rule_y" });
    const result = genesis({ driver, files: NO_FILES }, KEYS, { strict: true, now: NOW });
    const vault = result.vaults[0];
    if (vault === undefined) throw new Error("no vault");
    const gid = (id: number) =>
      vault.ids.find((e) => e.table === "inv_signals" && e.localId === String(id))?.gid;
    const order = vault.events
      .filter((e: WireEvent) => e.t.startsWith("signal."))
      .map((e) => [e.t, e.g]);
    expect(order).toEqual([
      ["signal.opened", gid(closed)],
      ["signal.closed", gid(closed)],
      ["signal.opened", gid(reopened)],
      ["signal.opened", gid(other)],
    ]);
    const store = openTestStore();
    store.applyWire({ device: vault.device, events: vault.events });
    const status = new Map(
      store
        .read<{ gid: string; status: string }>("SELECT gid, status FROM inv_signals")
        .map((r) => [r.gid, r.status]),
    );
    expect([status.get(gid(reopened) ?? ""), status.get(gid(closed) ?? "")]).toEqual([
      "active",
      "resolved",
    ]);
  });
});

describe("refusals", () => {
  it("refuses a profile without vault keys", () => {
    const { driver } = db();
    expect(
      errorOf(() => genesis({ driver, files: NO_FILES }, new Map(), { strict: true, now: NOW }))
        .code,
    ).toBe("missing_keys");
  });

  it("refuses a vault whose newest timestamp is ahead of the clock", () => {
    const { driver } = db();
    const now = Date.UTC(2025, 0, 1);
    expect(
      errorOf(() => genesis({ driver, files: NO_FILES }, KEYS, { strict: true, now })).code,
    ).toBe("clock_skew");
  });

  it("strict: a bad_* counter, an invalid event or an unmapped id fails the run", () => {
    const cases: [string, (r: PythonRows) => void][] = [
      ["strict_counter", (r) => r.insert("category_rules", { source: "auto" })],
      ["invalid_event", (r) => r.insert("alerts", { ...ALERT, kind: "bogus" })],
      ["unmapped_id_key", (r) => r.insert("alerts", { ...ALERT, params: '{"signal_id": 5}' })],
      // Python's `str(instrument_id)` candidate fallback: a local id as the key (review F6).
      [
        "strict_counter",
        (r) => r.insert("research_notes", { kind: "candidate", candidate_key: "42" }),
      ],
    ];
    for (const [code, plant] of cases) {
      const { driver, rows } = db();
      plant(rows);
      const run = () => genesis({ driver, files: NO_FILES }, KEYS, { strict: true, now: NOW });
      expect(errorOf(run).code, code).toBe(code);
    }
  });

  it("counts a digits-only candidate key (a local instrument id), strict names it", () => {
    const { driver, rows } = db();
    rows.insert("research_notes", { kind: "candidate", candidate_key: "42" });
    rows.insert("research_notes", { kind: "candidate", candidate_key: "PLTEST000001" });
    rows.insert("research_notes", { kind: "candidate", candidate_key: "ABC1" });
    const strict = () => genesis({ driver, files: NO_FILES }, KEYS, { strict: true, now: NOW });
    expect(errorOf(strict).message).toBe(
      "strict run refused: research_notes.candidate_key_local_id",
    );
    const result = genesis({ driver, files: NO_FILES }, KEYS, { strict: false, now: NOW });
    expect(result.report.counters.vaults["0"]?.research_notes).toEqual({
      candidate_key_local_id: 1,
    });
    expect(result.vaults[0]?.events.filter((e) => e.t === "note.added")).toHaveLength(3);
  });

  it("lenient: the rows are skipped, counted and left out of the ids", () => {
    const { driver, rows } = db();
    rows.insert("category_rules", { source: "auto" });
    rows.insert("alerts", { ...ALERT, kind: "bogus" });
    rows.insert("alerts", { ...ALERT, params: '{"signal_id": 5}' });
    rows.insert("alerts", { ...ALERT });
    const result = genesis({ driver, files: NO_FILES }, KEYS, { strict: false, now: NOW });
    const vault = result.vaults[0];
    expect(vault?.events.map((e) => e.t)).toEqual(["profile.created", "alert.created"]);
    expect(vault?.ids.map((e) => `${e.table}:${e.localId}`)).toEqual(["profiles:1", "alerts:3"]);
    // Phase 1 gave the dropped rows gids (other rows may reference them): named per table.
    expect(result.report.counters.vaults["0"]).toEqual({
      alerts: { dropped_after_phase1: 2, invalid_event: 1, "unmapped_id_key.params.signal_id": 1 },
      category_rules: { bad_enum: 1, dropped_after_phase1: 1 },
    });
  });
});
