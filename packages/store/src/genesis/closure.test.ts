// S26 spec 4.6 (D-G1), gid.md 7.3: the instrument closure of a vault reaches every reference of the
// profile (columns, signal keys and payloads, research details and scopes) and nothing else.
import { describe, expect, it } from "vitest";
import { instrumentClosure } from "./closure.js";
import { GenesisCounters } from "./report.js";
import { readPythonSource, scopeProfiles } from "./source.js";
import { NO_FILES } from "./testing/phase1.js";
import { PythonRows } from "./testing/pythonRows.js";
import { pythonDb } from "./testing/pythonSchema.js";

function closures(build: (rows: PythonRows) => void) {
  const driver = pythonDb();
  const rows = new PythonRows(driver);
  rows.insert("profiles", {});
  rows.insert("profiles", { slug: "beata" });
  rows.insert("accounts", {});
  for (let i = 0; i < 20; i++) rows.insert("inv_instruments", {});
  build(rows);
  const counters = new GenesisCounters();
  const source = readPythonSource(driver, NO_FILES, counters);
  const out = scopeProfiles(source, counters).map((scope, ordinal) =>
    instrumentClosure(scope, source.invInstruments, counters, ordinal),
  );
  return { closures: out, counters };
}

describe("instrumentClosure", () => {
  it("collects the instrument columns of every referencing table", () => {
    const {
      closures: [anna],
    } = closures((rows) => {
      rows.insert("inv_transactions", { instrument_id: 1 });
      rows.insert("inv_position_snapshots", { instrument_id: 2 });
      rows.insert("inv_manual_valuations", { instrument_id: 3 });
      rows.insert("inv_profile_instruments", { instrument_id: 4 });
      rows.insert("inv_theses", { instrument_id: 5 });
      rows.insert("alerts", { instrument_id: 6 });
      rows.insert("watchlist_items", { instrument_id: 7 });
      rows.insert("inv_decisions", { instrument_id: 8 });
      rows.insert("inv_instrument_renames", { old_instrument_id: 9, new_instrument_id: 10 });
      rows.insert("research_notes", { instrument_id: 11 });
      rows.insert("inv_signals", { instrument_id: 12 });
    });
    expect(anna).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("reads ids inside signal keys and payloads, research details and scopes", () => {
    const {
      closures: [anna],
    } = closures((rows) => {
      rows.insert("inv_signals", {
        dedup_key: "drawdown|i:13|a:1",
        payload: '{"instrument_id": "14"}',
      });
      rows.insert("inv_signals", { dedup_key: "plan:hold|i:015" });
      rows.insert("research_notes", { details: '{"previous_instrument_id": 16, "thesis_id": 17}' });
      rows.insert("research_runs", {
        scope: '{"instrument_ids": [17, "x"], "covered_instrument_ids": ["18"]}',
      });
    });
    expect(anna).toEqual([13, 14, 15, 16, 17, 18]);
  });

  it("keeps profiles apart, drops missing ids and counts the orphans per vault", () => {
    const {
      closures: [anna, beata],
      counters,
    } = closures((rows) => {
      rows.insert("inv_theses", { instrument_id: 1 });
      rows.insert("inv_theses", { instrument_id: 99 });
      rows.insert("watchlist_items", { profile_id: 2, instrument_id: 2 });
    });
    expect(anna).toEqual([1]);
    expect(beata).toEqual([2]);
    expect(counters.get("inv_instruments", "instrument_orphan", 0)).toBe(19);
    expect(counters.get("inv_instruments", "instrument_orphan", 1)).toBe(19);
  });
});
