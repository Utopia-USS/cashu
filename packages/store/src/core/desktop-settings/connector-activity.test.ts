import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type NewConnectorRun, restoreConnectorRuns } from "../../device/connector-runs.js";
import { DeviceStore } from "../../device/store.js";
import { betterSqlite3Driver } from "../../sql/better-sqlite3.js";
import { CONNECTOR_RUNS_LISTED, connectorActivity } from "./connector-activity.js";

const VAULT = "5f0c3a9e81d24b7690ae13c7d2f4b856";
const OTHER = "6f0c3a9e81d24b7690ae13c7d2f4b856";
const run: NewConnectorRun = {
  connectorId: "sample-fetch",
  vault: VAULT,
  legacyProfileId: null,
  bindingId: null,
  command: "fetch",
  startedAt: "2026-11-04T12:00:00.000Z",
  durationMs: 1250,
  outcome: "ok",
  errorKind: null,
  exitCode: null,
  records: 3,
  bytesIn: 0,
  bytesOut: 10,
  deniedHostsJson: '["denied.example"]',
  stderrTail: null,
  proposalId: null,
  batchRef: null,
};

describe("connectorActivity", () => {
  it("lists the vault's newest runs per connector and its bindings' fetch state, live", () => {
    const db = new Database(":memory:");
    const driver = betterSqlite3Driver(db);
    const device = DeviceStore.open(driver);
    const read = device.read.bind(device);
    for (let i = 0; i < CONNECTOR_RUNS_LISTED + 3; i++) device.appendConnectorRun(run);
    device.appendConnectorRun({
      ...run,
      connectorId: "other-fetch",
      outcome: "failed",
      errorKind: "auth_failed",
      records: 0,
      deniedHostsJson: "[]",
      stderrTail: "key [secret] rejected",
    });
    device.appendConnectorRun({ ...run, vault: OTHER, stderrTail: "other vault" });
    driver.transaction(() =>
      restoreConnectorRuns(driver, [
        { ...run, id: 9000, vault: null, legacyProfileId: 4, stderrTail: "no profile" },
      ]),
    );
    device.updateConnectorFetch(VAULT, "binding-1", {
      lastRunAt: "2026-11-04T12:00:00.000Z",
      lastStatus: "ok",
    });
    device.updateConnectorFetch(OTHER, "binding-2", { lastStatus: "failed" });

    const own = connectorActivity.run(read, { vault: VAULT, privacy: false });
    expect(own.runs.filter((r) => r.connectorId === "sample-fetch")).toHaveLength(
      CONNECTOR_RUNS_LISTED,
    );
    expect(own.runs[0]).toEqual({
      id: CONNECTOR_RUNS_LISTED + 4,
      connectorId: "other-fetch",
      command: "fetch",
      startedAt: "2026-11-04T12:00:00.000Z",
      durationMs: 1250,
      outcome: "failed",
      errorKind: "auth_failed",
      records: 0,
      deniedHosts: [],
      stderrTail: "key [secret] rejected",
    });
    expect(own.runs[1]?.deniedHosts).toEqual(["denied.example"]);
    expect(own.runs.map((r) => r.id)).toEqual([...own.runs.map((r) => r.id)].sort((a, b) => b - a));
    expect(JSON.stringify(own)).not.toContain("other vault");
    expect(JSON.stringify(own)).not.toContain("no profile");
    expect(own.bindings).toEqual([
      {
        binding: "binding-1",
        lastRunAt: "2026-11-04T12:00:00.000Z",
        lastStatus: "ok",
        lastOkAt: null,
        backoffUntil: null,
      },
    ]);
    const hidden = connectorActivity.run(read, { vault: VAULT, privacy: true });
    expect(hidden.runs.every((r) => r.stderrTail === null)).toBe(true);
    expect(hidden.runs).toHaveLength(own.runs.length);
    expect(connectorActivity.run(read, { vault: "nope", privacy: false })).toEqual({
      runs: [],
      bindings: [],
    });

    const sql = "SELECT 1 FROM connector_runs, local_connector_fetch";
    const tables = device.tablesRead(sql);
    expect(tables).toEqual(new Set(["connector_runs", "local_connector_fetch"]));
    const before = device.version(tables);
    device.appendConnectorRun(run);
    device.updateConnectorFetch(VAULT, "binding-1", { lastOkAt: "2026-11-04T12:00:00.000Z" });
    expect(device.version(tables)).toBeGreaterThan(before);
    device.close();
  });
});
