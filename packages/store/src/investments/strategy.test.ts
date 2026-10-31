// Strategy versions and rule runs (S25 spec 4.6, 4.7; scenario S1). Synthetic data only.
import { describe, expect, it } from "vitest";
import { openTestStore } from "../testing/store.js";
import { converge, DEV_B, Events, rows, ulid } from "./testing/kit.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("inv_strategy_versions", () => {
  it("numbers versions in order; a version equal to the current sha is a no-op", () => {
    const store = openTestStore();
    const ev = new Events();
    const r = store.applyEnvelopes([
      ev.make("strategy.versionSaved", ulid(1), { sha256: SHA_A }, { wall: 10 }),
      ev.make("strategy.versionSaved", ulid(2), { sha256: SHA_A }, { wall: 20 }),
      ev.make(
        "strategy.versionSaved",
        ulid(3),
        { sha256: SHA_B, mdText: "# Strategia" },
        { wall: 30 },
      ),
    ]);
    expect([...r.touchedTables]).toEqual(["inv_strategy_versions"]);
    expect(rows(store, "inv_strategy_versions").map((v) => [v.gid, v.version, v.sha256])).toEqual([
      [ulid(1), 1, SHA_A],
      [ulid(3), 2, SHA_B],
    ]);
  });

  it("S1: A, B, revert to A, and a second device's copy of B right after B, in any order", () => {
    const a = new Events();
    const b = new Events(DEV_B, "01JB");
    const events = [
      a.make("strategy.versionSaved", ulid(1), { sha256: SHA_A }, { wall: 10 }),
      a.make("strategy.versionSaved", ulid(2), { sha256: SHA_B }, { wall: 20 }),
      b.make("strategy.versionSaved", ulid(3), { sha256: SHA_B }, { wall: 21 }),
      a.make("strategy.versionSaved", ulid(4), { sha256: SHA_A }, { wall: 30 }),
    ];
    converge(events, (store) => {
      expect(rows(store, "inv_strategy_versions").map((v) => [v.gid, v.version])).toEqual([
        [ulid(1), 1],
        [ulid(2), 2],
        [ulid(4), 3],
      ]);
    });
  });
});

describe("inv_rule_runs", () => {
  it("appends every run with its strategy version as named and the report as signal gids", () => {
    const store = openTestStore();
    const ev = new Events();
    const sig = ulid(50);
    store.applyEnvelopes([
      ev.make("strategy.versionSaved", ulid(1), { sha256: SHA_A }),
      ev.make("ruleRun.finished", ulid(2), {
        strategyVersion: ulid(1),
        stats: { rules: 3 },
        report: { new: [sig], escalated: [] },
      }),
      ev.make("ruleRun.finished", ulid(3), { status: "failed", finishedAt: null, errors: ["x"] }),
    ]);
    expect(rows(store, "inv_rule_runs")).toEqual([
      {
        gid: ulid(2),
        trigger: "worker",
        as_of: "2026-03-02",
        status: "ok",
        strategy_version_id: ulid(1),
        stats: { rules: 3 },
        errors: [],
        report: { new: [sig], escalated: [] },
        started_at: "2026-03-02 06:00:00.000000",
        finished_at: "2026-03-02 06:00:05.000000",
      },
      expect.objectContaining({ gid: ulid(3), status: "failed", finished_at: null, errors: ["x"] }),
    ]);
  });
});
