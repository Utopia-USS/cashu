/// <reference types="node" />
// S26 spec 6.4 / 6.5, gid.md 6 and 7.6: every rewrite row (key strings, rule ids, signal payload,
// rule-run report, research details and scope, proposal payload with staged blobs), every dangling
// case with its counter, and the guard failing `unmapped_id_key` on planted ids. Synthetic only.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GenesisError } from "./report.js";
import { Rewriter } from "./rewrite.js";
import type { GenesisFiles } from "./source.js";
import { gidOf, phase1 } from "./testing/phase1.js";
import { PythonRows } from "./testing/pythonRows.js";
import { pythonDb } from "./testing/pythonSchema.js";

const STAGED_BYTES = new TextEncoder().encode("synthetic export\n");
const STAGED_SHA = createHash("sha256").update(STAGED_BYTES).digest("hex");
const STAGED = `imports/anna/.proposals/${STAGED_SHA}-0a1b2c3d4e5f.CSV`;
const OTHER_SHA = "f".repeat(64);

function setup() {
  const driver = pythonDb();
  const rows = new PythonRows(driver);
  rows.insert("profiles", {});
  rows.insert("profiles", { slug: "beata" });
  rows.insert("accounts", {});
  rows.insert("accounts", { profile_id: 2 });
  rows.insert("inv_instruments", {});
  rows.insert("inv_theses", {});
  rows.insert("watchlist_items", {});
  rows.insert("alerts", {});
  rows.insert("alerts", { profile_id: 2 });
  rows.insert("research_notes", {});
  rows.insert("inv_signals", {});
  const files: GenesisFiles = {
    read: (rel) =>
      rel === STAGED
        ? STAGED_BYTES
        : rel.includes(OTHER_SHA)
          ? new TextEncoder().encode("different bytes")
          : undefined,
    list: () => [],
  };
  const { vaults, counters } = phase1(driver, files);
  const v = vaults[0];
  if (v === undefined) throw new Error("no vault");
  const r = new Rewriter(v, counters, 0, files);
  const count = (table: string, reason: string) => counters.get(table, reason, 0);
  const g = {
    account: gidOf(v, "accounts", 1),
    instrument: gidOf(v, "inv_instruments", 1),
    thesis: gidOf(v, "inv_theses", 1),
    watch: gidOf(v, "watchlist_items", 1),
    alert: gidOf(v, "alerts", 1),
    note: gidOf(v, "research_notes", 1),
    signal: gidOf(v, "inv_signals", 1),
    missing: (table: string, id: number) => v.missingGid(table, id),
  };
  return { r, count, g };
}

function refusal(fn: () => unknown): GenesisError | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof GenesisError) return e;
    throw e;
  }
  return undefined;
}

describe("key strings (6.5 row 1, rule ids)", () => {
  it("rewrites i: / a: parts and a whole alert key, other parts unchanged", () => {
    const { r, g, count } = setup();
    expect(r.key("inv_signals", "drawdown|i:1|a:1")).toBe(
      `drawdown|i:${g.instrument}|a:${g.account}`,
    );
    expect(r.key("inv_signals", "plan:hold|i:1")).toBe(`plan:hold|i:${g.instrument}`);
    expect(r.key("inv_signals", "research:2026-W10|i:1|s:etf|t:ai")).toBe(
      `research:2026-W10|i:${g.instrument}|s:etf|t:ai`,
    );
    expect(r.key("inv_signals", "alert:1")).toBe(`alert:${g.alert}`);
    expect(r.key("inv_signals", "cash_level|x:1")).toBe("cash_level|x:1");
    expect(count("inv_signals", "dangling_key_id")).toBe(0);
  });

  it("puts the genesis gid of a missing or foreign row into a key (counted)", () => {
    const { r, g, count } = setup();
    expect(r.key("inv_signals", "drawdown|i:99|a:2")).toBe(
      `drawdown|i:${g.missing("inv_instruments", 99)}|a:${g.missing("accounts", 2)}`,
    );
    expect(r.key("inv_signals", "alert:2")).toBe(`alert:${g.missing("alerts", 2)}`);
    expect(count("inv_signals", "dangling_key_id")).toBe(3);
  });

  it("rewrites only a whole alert rule id", () => {
    const { r, g } = setup();
    expect(r.ruleId("inv_signals", "alert:1")).toBe(`alert:${g.alert}`);
    expect(r.ruleId("inv_signals", "drawdown|i:1")).toBe("drawdown|i:1");
    expect(r.ruleId("inv_signals", "rule_test")).toBe("rule_test");
  });
});

describe("typed references and id lists (7.6)", () => {
  it("nullable column: gid, null when missing or foreign (counted), null stays null", () => {
    const { r, g, count } = setup();
    expect(r.ref("inv_signals", "instrument_id", "inv_instruments", 1)).toBe(g.instrument);
    expect(r.ref("inv_signals", "instrument_id", "inv_instruments", 99)).toBeNull();
    expect(r.ref("inv_signals", "account_id", "accounts", 2)).toBeNull();
    expect(r.ref("inv_signals", "account_id", "accounts", null)).toBeNull();
    expect(count("inv_signals", "dangling_instrument_id")).toBe(1);
    expect(count("inv_signals", "dangling_account_id")).toBe(1);
  });

  it("id list: dangling ids dropped (counted), non-ids kept", () => {
    const { r, g, count } = setup();
    expect(r.refs("inv_decisions", "signals", "inv_signals", [1, 5, "1"])).toEqual([
      g.signal,
      g.signal,
    ]);
    expect(count("inv_decisions", "dangling_signals")).toBe(1);
  });
});

describe("JSON rules (6.5)", () => {
  it("inv_signals.payload", () => {
    const { r, g, count } = setup();
    const payload = {
      instrument_id: "1",
      alert_id: 2,
      note_id: 1,
      note_ids: [1, 99, "x"],
      accounts: [1, 2],
      symbol: "ABC",
    };
    expect(r.json("inv_signals", "payload", payload)).toEqual({
      instrument_id: g.instrument,
      alert_id: null,
      note_id: g.note,
      note_ids: [g.note, "x"],
      accounts: [g.account],
      symbol: "ABC",
    });
    expect(r.json("inv_signals", "payload", { instrument_id: 1, accounts: 3 })).toEqual({
      instrument_id: g.instrument,
      accounts: 3,
    });
    expect(count("inv_signals", "dangling_payload.alert_id")).toBe(1);
    expect(count("inv_signals", "dangling_payload.note_ids")).toBe(1);
    expect(count("inv_signals", "dangling_payload.accounts")).toBe(1);
  });

  it("inv_rule_runs.report: new / escalated -> signal gids, other keys walked only", () => {
    const { r, g, count } = setup();
    expect(r.json("inv_rule_runs", "report", { new: [1, 99], escalated: [1], kept: 2 })).toEqual({
      new: [g.signal],
      escalated: [g.signal],
      kept: 2,
    });
    expect(count("inv_rule_runs", "dangling_report.new")).toBe(1);
  });

  it("research_notes.details and research_runs.scope", () => {
    const { r, g, count } = setup();
    expect(
      r.json("research_notes", "details", {
        watchlist_item_id: 1,
        thesis_id: 99,
        previous_instrument_id: 1,
        created_thesis: true,
      }),
    ).toEqual({
      watchlist_item_id: g.watch,
      thesis_id: null,
      previous_instrument_id: g.instrument,
      created_thesis: true,
    });
    expect(count("research_notes", "dangling_details.thesis_id")).toBe(1);
    expect(
      r.json("research_runs", "scope", { instrument_ids: [1, 99], covered_instrument_ids: ["1"] }),
    ).toEqual({ instrument_ids: [g.instrument], covered_instrument_ids: [g.instrument] });
    expect(count("research_runs", "dangling_scope.instrument_ids")).toBe(1);
  });

  it("proposals.payload: account_id -> account, staged -> blob (file hashed when present)", () => {
    const { r, g, count } = setup();
    expect(
      r.json("proposals", "payload", { account_id: 1, staged: STAGED, file_name: "x.csv" }),
    ).toEqual({ account: g.account, blob: { sha256: STAGED_SHA, ext: "csv" }, file_name: "x.csv" });
    expect(count("proposals", "staged_missing") + count("proposals", "staged_hash_mismatch")).toBe(
      0,
    );
    expect(r.json("proposals", "payload", { account_id: 2, staged: `${OTHER_SHA}.pdf` })).toEqual({
      account: null,
      blob: { sha256: OTHER_SHA, ext: "pdf" },
    });
    expect(r.json("proposals", "payload", { staged: `a/${"e".repeat(64)}.csv` })).toEqual({
      blob: { sha256: "e".repeat(64), ext: "csv" },
    });
    expect(r.json("proposals", "payload", { staged: "../x.csv", account_id: null })).toEqual({
      blob: null,
      account: null,
    });
    expect(r.json("proposals", "payload", { staged: null })).toEqual({ blob: null });
    expect(count("proposals", "dangling_payload.account_id")).toBe(1);
    expect(count("proposals", "staged_hash_mismatch")).toBe(1);
    expect(count("proposals", "staged_missing")).toBe(1);
    expect(count("proposals", "staged_invalid")).toBe(1);
  });
});

describe("connector proposals (open decision)", () => {
  it("fails closed on a local binding id in a proposal payload", () => {
    const { r, count } = setup();
    expect(() => r.json("proposals", "payload", { binding_id: 3, run_id: 7 })).toThrow(
      GenesisError,
    );
    expect(count("proposals", "unmapped_id_key.payload.binding_id")).toBe(1);
  });
});

describe("the guard walker (6.5, R5)", () => {
  it("passes vocabulary keys without ids and JSON without id keys", () => {
    const { r } = setup();
    const params = { threshold: 5, instrument_id: null, run_id: "abc", nested: [{ count: 3 }] };
    expect(r.json("alerts", "params", params)).toEqual(params);
  });

  it.each([
    ["alerts", "params", { alert_id: 5 }, "unmapped_id_key.params.alert_id"],
    ["reviews", "stats", { x: [{ signal_ids: ["3"] }] }, "unmapped_id_key.stats.signal_ids"],
    ["research_runs", "counts", { lead_note_id: 4 }, "unmapped_id_key.counts.lead_note_id"],
    [
      "inv_signals",
      "payload",
      { detail: { instrument_id: 1 } },
      "unmapped_id_key.payload.instrument_id",
    ],
    ["proposals", "payload", { run_id: 12 }, "unmapped_id_key.payload.run_id"],
  ])("fails %s.%s on a planted id", (table, column, value, reason) => {
    const { r, count } = setup();
    expect(refusal(() => r.json(table, column, value))?.code).toBe("unmapped_id_key");
    expect(count(table, reason)).toBe(1);
  });
});
