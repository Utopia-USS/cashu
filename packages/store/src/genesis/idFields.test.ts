// S26 spec 6.5: the guard's id-key vocabulary (the Python app's canonical `FIELD_TABLES`, which
// Python data dirs imported by `cashu migrate` use), plus the id-suffix rule and what counts as a
// local id inside JSON.
import { describe, expect, it } from "vitest";
import { ALERT_KEY_RE, idFieldTable, isJsonObject, KEY_PART_RE, rowIdOf } from "./idFields.js";

/** The Python app's `FIELD_TABLES`: id field name -> table. */
const FIELD_TABLES: readonly (readonly [string, string])[] = [
  ["profile_id", "profiles"],
  ["account_id", "accounts"],
  ["account_ids", "accounts"],
  ["instrument_id", "inv_instruments"],
  ["instrument_ids", "inv_instruments"],
  ["old_instrument_id", "inv_instruments"],
  ["new_instrument_id", "inv_instruments"],
  ["signal_id", "inv_signals"],
  ["signal_ids", "inv_signals"],
  ["alert_id", "alerts"],
  ["alert_ids", "alerts"],
  ["thesis_id", "inv_theses"],
  ["topic_thesis_id", "inv_topic_theses"],
  ["note_id", "research_notes"],
  ["note_ids", "research_notes"],
  ["decision_id", "inv_decisions"],
  ["decision_ids", "inv_decisions"],
  ["loan_id", "loans"],
  ["version_id", "inv_strategy_versions"],
  ["strategy_version_id", "inv_strategy_versions"],
  ["proposal_id", "proposals"],
  ["deposit_id", "inv_planned_deposits"],
  ["review_id", "reviews"],
  ["valuation_id", "inv_manual_valuations"],
  ["created_run_id", "inv_rule_runs"],
  ["last_run_id", "inv_rule_runs"],
  ["rule_run_id", "inv_rule_runs"],
  ["research_run_id", "research_runs"],
  ["new_signal_ids", "inv_signals"],
  ["open_txn_id", "inv_transactions"],
  ["close_txn_id", "inv_transactions"],
  ["batch_id", "inv_import_batches"],
  ["import_batch_id", "inv_import_batches"],
  ["item_id", "watchlist_items"],
  ["run_id", "research_runs"],
  ["running_run_id", "research_runs"],
  ["watchlist_item_id", "watchlist_items"],
  ["watch_item_id", "watchlist_items"],
];

describe("idFieldTable", () => {
  it("knows every key of the Python FIELD_TABLES with the same table", () => {
    for (const [key, table] of FIELD_TABLES) expect(idFieldTable(key), key).toBe(table);
  });

  it("reads the common id suffixes, and nothing else", () => {
    expect(idFieldTable("previous_instrument_id")).toBe("inv_instruments");
    expect(idFieldTable("lead_note_ids")).toBe("research_notes");
    expect(idFieldTable("source_account_id")).toBe("accounts");
    expect(idFieldTable("binding_id")).toBeUndefined();
    expect(idFieldTable("accounts")).toBeUndefined();
    expect(idFieldTable("instrument")).toBeUndefined();
  });
});

describe("rowIdOf", () => {
  it.each([
    [7, 7],
    ["7", 7],
    [0, 0],
    ["07", undefined],
    ["0", undefined],
    [1.5, undefined],
    [true, undefined],
    [null, undefined],
    ["abc", undefined],
    ["99999999999999999999", undefined],
  ])("%j -> %j", (value, id) => {
    expect(rowIdOf(value)).toBe(id);
  });
});

describe("key patterns and JSON objects", () => {
  it("matches id key parts and whole alert keys only", () => {
    expect(KEY_PART_RE.exec("i:12")?.slice(1)).toEqual(["i", "12"]);
    expect(KEY_PART_RE.test("s:etf")).toBe(false);
    expect(ALERT_KEY_RE.exec("alert:3")?.[1]).toBe("3");
    expect(ALERT_KEY_RE.test("alert:3|i:1")).toBe(false);
  });

  it("tells objects from arrays and null", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
  });
});
