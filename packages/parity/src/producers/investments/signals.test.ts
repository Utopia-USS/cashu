import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { withPythonDb } from "../../sources/pythonDb.ts";
import { type SyntheticDataset, syntheticDataset } from "../../sources/testing.ts";
import { dumps } from "../output.ts";
import { canonicalSignalValue, produceSignals, signalClock } from "./signals.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/signals-view.json", import.meta.url), "utf8"),
) as { sql: string; expected: unknown };
let ds: SyntheticDataset | undefined;
afterEach(() => ds?.dispose());

it("matches actual Python signals_view open/history/all over a synthetic stored dataset", () => {
  ds = syntheticDataset(fixture.sql);
  withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
    expect(JSON.parse(dumps(produceSignals(db)))).toEqual(fixture.expected);
  });
});

it("reads native stored state anew, without oracle-result inputs", () => {
  ds = syntheticDataset(fixture.sql);
  const run = () =>
    withPythonDb({ dataset: "demo", sourceDir: ds?.dir, runRoot: ds?.runRoot }, (db) =>
      JSON.parse(dumps(produceSignals(db))),
    );
  const before = run();
  ds.exec("UPDATE inv_signals SET message = 'Changed synthetic message' WHERE id = 1");
  expect(run()).not.toEqual(before);
});

describe("legacy signal canonical references", () => {
  const keys = { key: (table: string, value: number | bigint) => `${table}:${value}` };
  const ids = { keys } as Parameters<typeof canonicalSignalValue>[1];
  it("uses the caller's bare-id fallback while preserving known parent and field mappings", () => {
    const value = { params: { id: 7n }, signal: { id: 1n }, instrument_id: 2n };
    expect(JSON.parse(dumps(canonicalSignalValue(value, ids, "", "", "alerts")))).toEqual({
      params: { id: "alerts:7" },
      signal: { id: "inv_signals:1" },
      instrument_id: "inv_instruments:2",
    });
    expect(JSON.parse(dumps(canonicalSignalValue(value, ids)))).toEqual({
      params: { id: "inv_signals:7" },
      signal: { id: "inv_signals:1" },
      instrument_id: "inv_instruments:2",
    });
    expect(() => canonicalSignalValue({ unknown_id: 1n }, ids, "", "", "alerts")).toThrow(
      "unmapped stored signal reference",
    );
  });
  it("maps nested links and suffix references while retaining opaque keys and float types", () => {
    const value = canonicalSignalValue(
      {
        id: 1n,
        dedup_key: "rule|i:2",
        rule_id: "alert:7",
        payload: { note_id: 5n, covered_instrument_ids: [2n, "3"], threshold: 2.0 },
        decisions: [{ id: 4n, signal_ids: [1n, 2n] }],
      },
      ids,
    );
    expect(dumps(value)).toBe(
      '{"decisions":[{"id":"inv_decisions:4","signal_ids":["inv_signals:1","inv_signals:2"]}],"dedup_key":"rule|i:2","id":"inv_signals:1","payload":{"covered_instrument_ids":["inv_instruments:2","inv_instruments:3"],"note_id":"research_notes:5","threshold":2.0},"rule_id":"alert:7"}\n',
    );
  });
  it("fails on unplaced numeric ids, retaining non-id integers, bools and leading-zero text", () => {
    expect(() => canonicalSignalValue({ rule_id: "123" }, ids)).toThrow(
      "unmapped stored signal reference",
    );
    expect(dumps(canonicalSignalValue({ rule_id: "0123", note_id: true, count: 2n }, ids))).toBe(
      '{"count":2,"note_id":true,"rule_id":"0123"}\n',
    );
  });
});

it("uses frozen Warsaw noon with the dataset's actual DST offset", () => {
  expect(signalClock({ dataset: "demo" })).toBe("2026-10-01T10:00:00.000Z");
  expect(signalClock({ dataset: "lab" })).toBe("2026-10-31T11:00:00.000Z");
});
