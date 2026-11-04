import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import {
  appendConnectorRun,
  type ConnectorRunRecord,
  ensureConnectorRunHistory,
  listConnectorRuns,
  restoreConnectorRuns,
} from "./connector-runs.js";
import { DeviceStore } from "./store.js";

const VAULT_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VAULT_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const history: ConnectorRunRecord = {
  id: 7,
  connectorId: "sample-fetch",
  vault: null,
  legacyProfileId: null,
  bindingId: null,
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

it("restores every historical field and keeps global rows behind owner read", () => {
  const driver = betterSqlite3Driver(new Database(":memory:"));
  ensureConnectorRunHistory(driver);
  driver.transaction(() => restoreConnectorRuns(driver, [history]));
  expect(listConnectorRuns(driver, { kind: "vault", vault: VAULT_A })).toEqual([]);
  expect(() =>
    listConnectorRuns(driver, { kind: "global-owner", ownerAction: true, isCurrent: () => false }),
  ).toThrow();
  expect(
    listConnectorRuns(driver, { kind: "global-owner", ownerAction: true, isCurrent: () => true }),
  ).toEqual([history]);
  expect(() => restoreConnectorRuns(driver, [history])).toThrow();
  driver.close();
});

it("scopes new run history by vault and rejects raw future stderr", () => {
  const driver = betterSqlite3Driver(new Database(":memory:"));
  const device = DeviceStore.open(driver);
  const common = {
    connectorId: "sample-fetch",
    legacyProfileId: null,
    bindingId: null,
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
