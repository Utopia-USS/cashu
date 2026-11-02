import { D, investments as inv } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import type { PythonDb } from "../../sources/pythonDb.ts";
import { dumps } from "../output.ts";
import { REVIEW_DIGEST_FLOAT_PATHS, viewOutput } from "./viewOutput.ts";

const alert = "0a1b2c3d-0000-8000-8000-000000000001";
const instrument = "0a1b2c3d-0000-8000-8000-000000000002";
const account = "01JQ0000000000000000000003";
const sources = new Map([
  [alert, { table: "alerts", localId: "7" }],
  [instrument, { table: "inv_instruments", localId: "9" }],
  [account, { table: "accounts", localId: "4" }],
]);
const vault = { sources, det: (() => "unused") as never };
const db = {
  keys: { key: (table: string, id: number | bigint) => `${table}:${String(id)}` },
} as Pick<PythonDb, "keys">;
const output = (value: unknown, floatPaths: readonly string[] = []) =>
  viewOutput(value, db, vault, { floatPaths });

describe("native view wire boundary", () => {
  it("reverses only typed embedded key parts, retaining arbitrary authored rule text", () => {
    const text = "rule-00000000000000000000000000000000";
    expect(output({ rule_id: text, dedup_key: `${text}|arbitrary:${instrument}` })).toEqual({
      rule_id: text,
      dedup_key: `${text}|arbitrary:${instrument}`,
    });
    expect(
      output({ rule_id: `alert:${alert}`, dedup_key: `rule|i:${instrument}|a:${account}` }),
    ).toEqual({ rule_id: "alert:7", dedup_key: "rule|i:9|a:4" });
    expect(output({ alert_id: alert, instrument_id: instrument, account_id: account })).toEqual({
      alert_id: "alerts:7",
      instrument_id: "inv_instruments:9",
      account_id: "accounts:4",
    });
  });
  it("refuses unknown references and incorrect field/table pairings", () => {
    expect(() => output({ rule_id: "alert:01JQ0000000000000000000099" })).toThrow(
      "copied-source identity",
    );
    expect(() => output({ mystery_id: instrument })).toThrow("unmapped stored signal reference");
    expect(() => output({ instrument_id: account })).toThrow("reference table differs");
  });
  it("keeps integer lookbacks/counters distinct from a float threshold equal to one", () => {
    const wire = dumps(
      output(
        {
          payload: { lookback: 5n, counter: 1n, threshold: 1 },
          message_params: { days: 5, threshold: 1 },
        },
        ["payload.threshold", "message_params.threshold"],
      ),
    );
    expect(wire).toBe(
      '{"message_params":{"days":5,"threshold":1.0},"payload":{"counter":1,"lookback":5,"threshold":1.0}}\n',
    );
  });
  it("treats a dotted bucket name as one actual dictionary key", () => {
    expect(dumps(output({ facts: { targets: { "equity.eu": 1 } } }, ["facts.targets.*"]))).toBe(
      '{"facts":{"targets":{"equity.eu":1.0}}}\n',
    );
    expect(
      dumps(
        viewOutput({ payload: { "key.with.dots": 1 } }, db, vault, {
          floatPaths: [["payload", "key.with.dots"]],
        }),
      ),
    ).toBe('{"payload":{"key.with.dots":1.0}}\n');
  });
  it("preserves declared bucket/rule identifiers and dictionary keys that collide with a known gid", () => {
    const input = {
      facts: {
        targets: { [instrument]: 1 },
        rules: [{ id: instrument }],
        bucket_matches: [{ id: instrument }],
      },
      instrument_id: instrument,
      account_id: account,
    };
    const wire = viewOutput(input, db, vault, {
      floatPaths: ["facts.targets.*"],
      literalIdPaths: ["facts.rules.*.id", "facts.bucket_matches.*.id"],
    });
    expect(JSON.parse(dumps(wire))).toEqual({
      ...input,
      instrument_id: "inv_instruments:9",
      account_id: "accounts:4",
    });
  });
  it("converts only declared API money fields and preserves Decimal context text", () => {
    expect(
      dumps(
        output(
          { events: [{ amount: D("12.50") }], warnings: [{ context: { amount: D("12.50") } }] },
          REVIEW_DIGEST_FLOAT_PATHS,
        ),
      ),
    ).toBe('{"events":[{"amount":12.5}],"warnings":[{"context":{"amount":"12.50"}}]}\n');
  });
  it("formats exact freshness microseconds and canonical reason refs", () => {
    const at = inv.research.utcInstant("2026-10-01", 10, 0, 0, 123456);
    const freshness = new inv.plan.Freshness("maybe_outdated", [
      { code: "alert_triggered", at, alertId: alert },
    ]);
    expect(output({ plan_freshness: freshness })).toEqual({
      plan_freshness: {
        state: "maybe_outdated",
        reasons: [
          { code: "alert_triggered", at: "2026-10-01T10:00:00.123456+00:00", alert_id: "alerts:7" },
        ],
      },
    });
  });
});
