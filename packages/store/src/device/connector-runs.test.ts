import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import {
  appendConnectorRun,
  type ConnectorRunRecord,
  connectorFetchState,
  ensureConnectorRunHistory,
  KEEP_CONNECTOR_RUNS,
  listConnectorRuns,
  type NewConnectorRun,
} from "./connector-runs.js";
import { DeviceStore } from "./store.js";

const VAULT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VAULT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
it("keeps runs of no vault behind owner read", () => {
  const driver = betterSqlite3Driver(new Database(":memory:"));
  ensureConnectorRunHistory(driver);
  const global: NewConnectorRun = {
    connectorId: "sample-fetch",
    vault: null,
    binding: null,
    command: "check",
    startedAt: "2026-09-01 08:00:00.000000",
    durationMs: 13,
    outcome: "error",
    errorKind: "protocol",
    exitCode: 1,
    records: 0,
    bytesIn: 12,
    bytesOut: 6,
    deniedHostsJson: '["denied.example"]',
    stderrTail: "synthetic [REDACTED] tail",
    proposalId: null,
    batchRef: null,
  };
  const id = appendConnectorRun(driver, global);
  expect(listConnectorRuns(driver, { kind: "vault", vault: VAULT_A })).toEqual([]);
  expect(() =>
    listConnectorRuns(driver, { kind: "global-owner", ownerAction: true, isCurrent: () => false }),
  ).toThrow();
  const { binding: _binding, ...stored } = global;
  expect(
    listConnectorRuns(driver, { kind: "global-owner", ownerAction: true, isCurrent: () => true }),
  ).toEqual([{ id, ...stored } satisfies ConnectorRunRecord]);
  driver.close();
});

it("scopes new run history by vault", () => {
  const driver = betterSqlite3Driver(new Database(":memory:"));
  const device = DeviceStore.open(driver);
  const common = {
    connectorId: "sample-fetch",
    binding: null,
    command: "fetch",
    startedAt: "2026-11-04T12:00:00Z",
    durationMs: 2,
    outcome: "ok",
    errorKind: null,
    exitCode: 0,
    records: 1,
    bytesIn: 0,
    bytesOut: 100,
    deniedHostsJson: "[]",
    stderrTail: null,
    proposalId: null,
    batchRef: null,
  } as const;
  let notified = 0;
  device.subscribe(["connector_runs"], () => {
    notified += 1;
  });
  const a = device.appendConnectorRun({ ...common, vault: VAULT_A });
  appendConnectorRun(driver, { ...common, vault: VAULT_B });
  expect(notified).toBe(1);
  expect(listConnectorRuns(driver, { kind: "vault", vault: VAULT_A }).map((row) => row.id)).toEqual(
    [a],
  );
  expect(listConnectorRuns(driver, { kind: "vault", vault: VAULT_B })).toHaveLength(1);
  expect(
    listConnectorRuns(driver, { kind: "global-owner", ownerAction: true, isCurrent: () => true }),
  ).toEqual([]);
  expect(device.tablesRead("SELECT id FROM connector_runs")).toEqual(new Set(["connector_runs"]));
  expect(() =>
    device.removeConnectorRuns("sample-fetch", { ownerAction: true, isCurrent: () => false }),
  ).toThrow();
  expect(
    device.removeConnectorRuns("sample-fetch", { ownerAction: true, isCurrent: () => true }),
  ).toBe(2);
  expect(listConnectorRuns(driver, { kind: "vault", vault: VAULT_A })).toEqual([]);
  expect(listConnectorRuns(driver, { kind: "vault", vault: VAULT_B })).toEqual([]);
  expect(notified).toBe(2);
  device.close();
});

const run: NewConnectorRun = {
  connectorId: "sample-fetch",
  vault: VAULT_A,
  binding: "binding-a",
  command: "fetch",
  startedAt: "2026-11-04T12:00:00.000Z",
  durationMs: 2,
  outcome: "failed",
  errorKind: "auth_failed",
  exitCode: null,
  records: 0,
  bytesIn: 0,
  bytesOut: 0,
  deniedHostsJson: "[]",
  stderrTail: "key [secret] rejected",
  proposalId: null,
  batchRef: null,
};

it("keeps a redacted stderr tail and prunes each connector to the newest runs", () => {
  const driver = betterSqlite3Driver(new Database(":memory:"));
  ensureConnectorRunHistory(driver);
  for (let i = 0; i < KEEP_CONNECTOR_RUNS + 2; i++) appendConnectorRun(driver, run);
  appendConnectorRun(driver, { ...run, connectorId: "other-fetch" });
  const count = (id: string) =>
    driver
      .prepare("SELECT COUNT(*) AS n, MIN(id) AS first FROM connector_runs WHERE connector_id = ?")
      .get<{ n: number; first: number }>(id);
  expect(count("sample-fetch")).toEqual({ n: KEEP_CONNECTOR_RUNS, first: 3 });
  expect(count("other-fetch")?.n).toBe(1);
  expect(
    listConnectorRuns(driver, { kind: "vault", vault: VAULT_A, limit: 1 })[0]?.stderrTail,
  ).toBe("key [secret] rejected");
  expect(() => appendConnectorRun(driver, { ...run, stderrTail: "x".repeat(4097) })).toThrow();
  driver.close();
});

it("adds the binding column to a run history created before runs recorded their binding", () => {
  const driver = betterSqlite3Driver(new Database(":memory:"));
  driver.exec(`CREATE TABLE connector_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, connector_id TEXT NOT NULL,
    vault TEXT, legacy_profile_id INTEGER, binding_id INTEGER, command TEXT NOT NULL, started_at TEXT NOT NULL,
    duration_ms INTEGER NOT NULL, outcome TEXT NOT NULL, error_kind TEXT, exit_code INTEGER, records INTEGER NOT NULL,
    bytes_in INTEGER NOT NULL, bytes_out INTEGER NOT NULL, denied_hosts_json TEXT NOT NULL, stderr_tail TEXT,
    proposal_id INTEGER, batch_ref TEXT)`);
  ensureConnectorRunHistory(driver);
  ensureConnectorRunHistory(driver);
  const id = appendConnectorRun(driver, run);
  expect(
    driver.prepare("SELECT binding FROM connector_runs WHERE id = ?").get<{ binding: string }>(id),
  ).toEqual({ binding: "binding-a" });
  driver.close();
});

it("updates a binding's fetch state field by field and notifies live readers", () => {
  const driver = betterSqlite3Driver(new Database(":memory:"));
  const device = DeviceStore.open(driver);
  let notified = 0;
  device.subscribe(["local_connector_fetch"], () => {
    notified += 1;
  });
  device.updateConnectorFetch(VAULT_A, "binding-1", { lastRunAt: "2026-11-04T12:00:00.000Z" });
  device.updateConnectorFetch(VAULT_A, "binding-1", {
    lastStatus: "failed",
    backoffUntil: "2026-11-06T12:00:00.000Z",
  });
  expect(connectorFetchState(driver, VAULT_A, "binding-1")).toEqual({
    binding: "binding-1",
    lastRunAt: "2026-11-04T12:00:00.000Z",
    lastStatus: "failed",
    lastOkAt: null,
    backoffUntil: "2026-11-06T12:00:00.000Z",
  });
  expect(connectorFetchState(driver, VAULT_B, "binding-1")).toBeUndefined();
  expect(notified).toBe(2);
  expect(device.tablesRead("SELECT 1 FROM local_connector_fetch")).toEqual(
    new Set(["local_connector_fetch"]),
  );
  expect(() => device.updateConnectorFetch("not-a-vault", "binding-1", {})).toThrow();
  device.close();
});
